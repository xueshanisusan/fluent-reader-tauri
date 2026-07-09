// The app-managed llama.cpp `server` process. We spawn it pointed at an
// installed model, wait for it to report healthy, and expose its local
// OpenAI-compatible endpoint. One process at a time, tracked in ManagedState.
//
// Binary resolution (2a): we do NOT use Tauri externalBin/sidecar yet — that
// would require the binary to exist at build time and break `pnpm tauri:dev`
// before the user has fetched it. Instead we resolve a path at runtime
// (LLAMA_SERVER_PATH override, else `<app_data_dir>/bin/llama-server[.exe]`) and
// spawn it directly. When installers land (bundle.active), switch to externalBin.
use crate::models::RuntimeError;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

// A 1–2 GB model can take a while to memory-map/load on a cold cache, and
// llama-server returns 503 on /health until it's ready — poll patiently.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(120);
const HEALTH_POLL_INTERVAL: Duration = Duration::from_millis(500);
const HEALTH_REQ_TIMEOUT: Duration = Duration::from_secs(2);
const START_ATTEMPTS: u32 = 3;

pub struct ManagedRuntime {
    pub child: CommandChild,
    pub port: u16,
    pub model_id: String,
    // Identifies THIS spawn. A dying sidecar's crash-watcher only clears the
    // slot if the generation still matches — so killing an old process to switch
    // models can't null out the new runtime we just installed in its place.
    pub generation: u64,
}

#[derive(Default)]
pub struct ManagedState {
    // Held across the async start so concurrent starts serialize (idempotent).
    pub runtime: tokio::sync::Mutex<Option<ManagedRuntime>>,
    // Single-flight guard for model downloads (see commands::model_download).
    pub downloading: AtomicBool,
    // Single-flight guard for the llama-server binary download, kept separate
    // from `downloading` so a model fetch and a binary fetch don't block each
    // other unnecessarily.
    pub downloading_binary: AtomicBool,
    // Monotonic spawn counter; each successful start claims the next value.
    pub generation: AtomicU64,
}

pub fn endpoint_for(port: u16) -> String {
    format!("http://127.0.0.1:{}/v1", port)
}

// A dying sidecar's watcher may clear the runtime slot only when the slot still
// holds ITS generation. Pure so the guard logic is unit-tested without a process.
fn watcher_should_clear(slot_generation: Option<u64>, my_generation: u64) -> bool {
    slot_generation == Some(my_generation)
}

/// Kill the current sidecar if any (idempotent). Returns once the kill signal is
/// sent; the OS may take a brief moment to release the model file's handle.
pub async fn stop(state: &ManagedState) {
    let mut guard = state.runtime.lock().await;
    if let Some(rt) = guard.take() {
        let _ = rt.child.kill();
    }
}

/// The model_id the running sidecar serves, if one is up.
pub async fn running_model_id(state: &ManagedState) -> Option<String> {
    state
        .runtime
        .lock()
        .await
        .as_ref()
        .map(|r| r.model_id.clone())
}

/// Reserve an ephemeral local port by binding to :0 and reading it back. The
/// listener is dropped immediately, so there's a TOCTOU window — callers retry.
pub fn free_port() -> Result<u16, RuntimeError> {
    let listener =
        std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| RuntimeError::Port {
            message: e.to_string(),
        })?;
    let port = listener
        .local_addr()
        .map_err(|e| RuntimeError::Port {
            message: e.to_string(),
        })?
        .port();
    Ok(port)
}

// Shared with runtime_install.rs so the installer writes to exactly the path
// this resolver checks.
pub fn server_binary_name() -> &'static str {
    if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    }
}

pub fn bin_dir(app: &AppHandle) -> Result<PathBuf, RuntimeError> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| RuntimeError::Spawn {
            message: e.to_string(),
        })?
        .join("bin"))
}

fn llama_server_path(app: &AppHandle) -> Result<PathBuf, RuntimeError> {
    if let Ok(p) = std::env::var("LLAMA_SERVER_PATH") {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return Ok(pb);
        }
    }
    let pb = bin_dir(app)?.join(server_binary_name());
    if pb.is_file() {
        Ok(pb)
    } else {
        Err(RuntimeError::NotInstalled {
            message: format!("llama-server binary not found at {}", pb.display()),
        })
    }
}

/// Whether a llama-server binary can currently be resolved (env override or
/// the app-managed `bin/` dir) — the gate the "Download" button in Settings
/// flips off.
pub fn is_binary_installed(app: &AppHandle) -> bool {
    llama_server_path(app).is_ok()
}

async fn health_ok(port: u16) -> bool {
    let client = match reqwest::Client::builder()
        .timeout(HEALTH_REQ_TIMEOUT)
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    match client
        .get(format!("http://127.0.0.1:{}/health", port))
        .send()
        .await
    {
        Ok(r) => r.status().is_success(),
        Err(_) => false,
    }
}

// Poll /health until 200, the process exits early, or we hit the timeout.
// A 503 (model still loading) or connection-refused just means "keep waiting".
async fn wait_healthy_or_exit(
    port: u16,
    rx: &mut tokio::sync::mpsc::Receiver<CommandEvent>,
) -> Result<(), RuntimeError> {
    let deadline = Instant::now() + HEALTH_TIMEOUT;
    loop {
        // Fail fast if the sidecar died instead of becoming healthy.
        while let Ok(ev) = rx.try_recv() {
            if let CommandEvent::Terminated(t) = ev {
                return Err(RuntimeError::Spawn {
                    message: format!("llama-server exited during startup (code {:?})", t.code),
                });
            }
        }
        if health_ok(port).await {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(RuntimeError::Health {
                message: "llama-server did not become healthy within 120s".to_string(),
            });
        }
        tokio::time::sleep(HEALTH_POLL_INTERVAL).await;
    }
}

/// Ensure a healthy sidecar is running for `model_path` and return its endpoint.
/// Idempotent: a healthy existing runtime is reused; a dead one is replaced.
pub async fn ensure_runtime(
    app: &AppHandle,
    state: &ManagedState,
    model_path: PathBuf,
    model_id: String,
) -> Result<String, RuntimeError> {
    let mut guard = state.runtime.lock().await;

    if let Some(rt) = guard.as_ref() {
        // Reuse only a healthy runtime serving the SAME model. A different
        // requested model (the user switched active) or a dead one is reaped.
        if rt.model_id == model_id && health_ok(rt.port).await {
            return Ok(endpoint_for(rt.port));
        }
        if let Some(old) = guard.take() {
            let _ = old.child.kill();
        }
    }

    let bin = llama_server_path(app)?;
    let mut last_err = RuntimeError::Spawn {
        message: "no start attempt made".to_string(),
    };

    for _ in 0..START_ATTEMPTS {
        let port = match free_port() {
            Ok(p) => p,
            Err(e) => {
                last_err = e;
                continue;
            }
        };
        let cmd = app.shell().command(bin.to_string_lossy().to_string()).args([
            "--model".to_string(),
            model_path.to_string_lossy().to_string(),
            "--port".to_string(),
            port.to_string(),
            "--host".to_string(),
            "127.0.0.1".to_string(),
            // Use the model's chat template.
            "--jinja".to_string(),
            // Never let a hybrid-reasoning model spend the request budget on a
            // <think> block — for translation we want the answer immediately, and
            // thinking output blew the request timeout on MiniCPM5.
            "--reasoning".to_string(),
            "off".to_string(),
            // A mild repeat penalty discourages the model from locking into an
            // echo/passthrough of the source. Set here (not in the request body)
            // so the request stays portable to strict OpenAI-compatible servers.
            "--repeat-penalty".to_string(),
            "1.1".to_string(),
        ]);
        let (mut rx, child) = match cmd.spawn() {
            Ok(pair) => pair,
            Err(e) => {
                last_err = RuntimeError::Spawn {
                    message: e.to_string(),
                };
                continue;
            }
        };

        match wait_healthy_or_exit(port, &mut rx).await {
            Ok(()) => {
                let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
                // Ongoing crash watcher: if the process dies later, clear the
                // runtime so the next translate transparently restarts it — but
                // ONLY if the slot still holds this generation. When we kill an
                // old process to switch models, its watcher fires after we've
                // installed the new runtime; the generation check stops it from
                // nulling the replacement.
                let app2 = app.clone();
                tokio::spawn(async move {
                    while let Some(ev) = rx.recv().await {
                        if let CommandEvent::Terminated(_) = ev {
                            if let Some(st) = app2.try_state::<ManagedState>() {
                                let mut g = st.runtime.lock().await;
                                if watcher_should_clear(
                                    g.as_ref().map(|r| r.generation),
                                    generation,
                                ) {
                                    *g = None;
                                }
                            }
                            break;
                        }
                    }
                });
                *guard = Some(ManagedRuntime {
                    child,
                    port,
                    model_id,
                    generation,
                });
                return Ok(endpoint_for(port));
            }
            Err(e) => {
                let _ = child.kill();
                last_err = e;
            }
        }
    }
    Err(last_err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn free_port_returns_usable_port() {
        let p = free_port().unwrap();
        assert!(p > 0);
    }

    #[test]
    fn endpoint_format() {
        assert_eq!(endpoint_for(8080), "http://127.0.0.1:8080/v1");
    }

    #[test]
    fn watcher_clears_only_its_own_generation() {
        // The slot holds this watcher's generation → safe to clear.
        assert!(watcher_should_clear(Some(3), 3));
        // The slot was replaced by a newer runtime (model switch) → must NOT clear.
        assert!(!watcher_should_clear(Some(4), 3));
        // Slot already empty → nothing to clear.
        assert!(!watcher_should_clear(None, 3));
    }
}
