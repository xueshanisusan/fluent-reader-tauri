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
use std::sync::atomic::AtomicBool;
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
    #[allow(dead_code)]
    pub model_id: String,
}

#[derive(Default)]
pub struct ManagedState {
    // Held across the async start so concurrent starts serialize (idempotent).
    pub runtime: tokio::sync::Mutex<Option<ManagedRuntime>>,
    // Single-flight guard for downloads (see commands::model_download).
    pub downloading: AtomicBool,
}

pub fn endpoint_for(port: u16) -> String {
    format!("http://127.0.0.1:{}/v1", port)
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

fn llama_server_path(app: &AppHandle) -> Result<PathBuf, RuntimeError> {
    if let Ok(p) = std::env::var("LLAMA_SERVER_PATH") {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return Ok(pb);
        }
    }
    let name = if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    };
    let pb = app
        .path()
        .app_data_dir()
        .map_err(|e| RuntimeError::Spawn {
            message: e.to_string(),
        })?
        .join("bin")
        .join(name);
    if pb.is_file() {
        Ok(pb)
    } else {
        Err(RuntimeError::NotInstalled {
            message: format!("llama-server binary not found at {}", pb.display()),
        })
    }
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
        if health_ok(rt.port).await {
            return Ok(endpoint_for(rt.port));
        }
        // Stale/dead — reap it and restart.
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
                // Ongoing crash watcher: if the process dies later, clear the
                // runtime so the next translate transparently restarts it.
                let app2 = app.clone();
                tokio::spawn(async move {
                    while let Some(ev) = rx.recv().await {
                        if let CommandEvent::Terminated(_) = ev {
                            if let Some(st) = app2.try_state::<ManagedState>() {
                                *st.runtime.lock().await = None;
                            }
                            break;
                        }
                    }
                });
                *guard = Some(ManagedRuntime {
                    child,
                    port,
                    model_id,
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
}
