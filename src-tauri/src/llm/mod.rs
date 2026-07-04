// App-managed local translation runtime (Phase 2a): download a curated GGUF,
// run it via a llama.cpp `server` process, and hand the translation flow a local
// OpenAI-compatible endpoint. Zero external setup (no Ollama).
pub mod catalog;
pub mod download;
pub mod manifest;
pub mod runtime;

pub use runtime::ManagedState;

use crate::models::{ModelError, RuntimeError};
use catalog::CuratedModel;
use download::DownloadProgress;
use manifest::InstalledModel;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

fn models_dir(app: &AppHandle) -> Result<PathBuf, ModelError> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| ModelError::Io {
            message: e.to_string(),
        })?
        .join("models"))
}

// The manifest entries whose files are actually present on disk (guards against
// a manifest listing a model the user deleted out-of-band).
fn installed_present(dir: &PathBuf) -> Result<Vec<InstalledModel>, ModelError> {
    Ok(manifest::read(dir)?
        .installed
        .into_iter()
        .filter(|e| dir.join(&e.file).is_file())
        .collect())
}

// The model the runtime should start: the active model if its file is present,
// else the first present entry, else nothing installed.
fn active_or_first(dir: &PathBuf) -> Result<Option<InstalledModel>, ModelError> {
    let m = manifest::read(dir)?;
    let present: Vec<InstalledModel> = m
        .installed
        .into_iter()
        .filter(|e| dir.join(&e.file).is_file())
        .collect();
    if let Some(active) = &m.active_id {
        if let Some(e) = present.iter().find(|e| &e.id == active) {
            return Ok(Some(e.clone()));
        }
    }
    Ok(present.into_iter().next())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    // Every installed model whose file is present on disk.
    pub installed: Vec<InstalledModel>,
    // The chosen active model's id (what the next translate will run), if any.
    pub active_id: Option<String>,
    // The model the sidecar is currently serving, if it's up.
    pub running_id: Option<String>,
    // Whether the sidecar is currently up.
    pub running: bool,
    // The live endpoint when running (random port per session).
    pub endpoint: Option<String>,
    // The id the "download recommended model" button pulls.
    pub default_model_id: String,
}

#[tauri::command]
pub async fn model_catalog() -> Result<Vec<CuratedModel>, ModelError> {
    Ok(catalog::CATALOG.to_vec())
}

#[tauri::command]
pub async fn model_status(
    app: AppHandle,
    state: State<'_, ManagedState>,
) -> Result<ModelStatus, ModelError> {
    let dir = models_dir(&app)?;
    let installed = installed_present(&dir)?;
    // Report the EFFECTIVE active id (falls back to first-present) so the picker
    // radio always reflects the model the next translate will actually run.
    let active_id = active_or_first(&dir)?.map(|e| e.id);
    let guard = state.runtime.lock().await;
    let (running, running_id, endpoint) = match guard.as_ref() {
        Some(rt) => (
            true,
            Some(rt.model_id.clone()),
            Some(runtime::endpoint_for(rt.port)),
        ),
        None => (false, None, None),
    };
    Ok(ModelStatus {
        installed,
        active_id,
        running_id,
        running,
        endpoint,
        default_model_id: catalog::DEFAULT_MODEL_ID.to_string(),
    })
}

#[tauri::command]
pub async fn model_download(
    app: AppHandle,
    state: State<'_, ManagedState>,
    id: String,
    on_progress: Channel<DownloadProgress>,
) -> Result<(), ModelError> {
    let cm = catalog::lookup(&id).ok_or_else(|| ModelError::NotFound {
        message: format!("unknown model id: {}", id),
    })?;

    // Single-flight: reject a second concurrent download rather than clobber the
    // same .part file.
    if state.downloading.swap(true, Ordering::SeqCst) {
        return Err(ModelError::Download {
            message: "a download is already in progress".to_string(),
        });
    }
    let dir = match models_dir(&app) {
        Ok(d) => d,
        Err(e) => {
            state.downloading.store(false, Ordering::SeqCst);
            return Err(e);
        }
    };
    let result = download::download(&dir, cm, &on_progress).await;
    state.downloading.store(false, Ordering::SeqCst);
    result
}

#[tauri::command]
pub async fn model_import(app: AppHandle, path: String) -> Result<InstalledModel, ModelError> {
    let dir = models_dir(&app)?;
    let src = PathBuf::from(path);
    // Copy + hash can be large/slow — keep it off the async worker threads.
    tokio::task::spawn_blocking(move || download::import(&dir, &src))
        .await
        .map_err(|e| ModelError::Io {
            message: e.to_string(),
        })?
}

#[tauri::command]
pub async fn runtime_start(
    app: AppHandle,
    state: State<'_, ManagedState>,
) -> Result<String, RuntimeError> {
    let dir = models_dir(&app).map_err(|e| RuntimeError::Spawn {
        message: format!("{:?}", e),
    })?;
    let installed = active_or_first(&dir)
        .map_err(|e| RuntimeError::Spawn {
            message: format!("{:?}", e),
        })?
        .ok_or_else(|| RuntimeError::NotInstalled {
            message: "no local model installed — download one first".to_string(),
        })?;
    let model_path = dir.join(&installed.file);
    runtime::ensure_runtime(&app, &state, model_path, installed.id).await
}

#[tauri::command]
pub async fn runtime_stop(state: State<'_, ManagedState>) -> Result<(), RuntimeError> {
    runtime::stop(&state).await;
    Ok(())
}

/// Choose which installed model the runtime uses. Lazy: does NOT restart a
/// running sidecar — the switch takes effect on the next translate (which calls
/// runtime_start and finds the model_id changed).
#[tauri::command]
pub async fn model_set_active(app: AppHandle, id: String) -> Result<(), ModelError> {
    let dir = models_dir(&app)?;
    // set_active requires a manifest entry; also confirm the file is present so
    // we never activate a model that can't actually start.
    if !installed_present(&dir)?.iter().any(|e| e.id == id) {
        return Err(ModelError::NotFound {
            message: format!("model not installed: {}", id),
        });
    }
    manifest::set_active(&dir, &id)
}

/// Remove an installed model: stop the sidecar if it's serving this model, wait
/// for the file handle to be released, delete the file, then drop the manifest
/// entry. Ordering matters on Windows (llama-server mmaps the .gguf — deleting
/// while it's open fails). A failed delete leaves the manifest entry intact.
#[tauri::command]
pub async fn model_uninstall(
    app: AppHandle,
    state: State<'_, ManagedState>,
    id: String,
) -> Result<(), ModelError> {
    let dir = models_dir(&app)?;
    let entry = manifest::read(&dir)?
        .installed
        .into_iter()
        .find(|e| e.id == id);

    // Stop the sidecar first if it's running THIS model, so the file unlocks.
    if runtime::running_model_id(&state).await.as_deref() == Some(id.as_str()) {
        runtime::stop(&state).await;
    }

    if let Some(entry) = &entry {
        let path = dir.join(&entry.file);
        remove_file_with_retry(&path)?;
    }
    manifest::remove(&dir, &id)
}

// Delete `path`, tolerating the brief window where a just-killed sidecar still
// holds the file open (Windows sharing violation). Already-gone counts as done.
fn remove_file_with_retry(path: &PathBuf) -> Result<(), ModelError> {
    use std::time::Duration;
    const ATTEMPTS: u32 = 20;
    const DELAY: Duration = Duration::from_millis(100);
    for attempt in 0..ATTEMPTS {
        match std::fs::remove_file(path) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) if attempt + 1 < ATTEMPTS => std::thread::sleep(DELAY),
            Err(e) => {
                return Err(ModelError::Io {
                    message: format!("couldn't remove model file (still in use?): {}", e),
                })
            }
        }
    }
    Ok(())
}
