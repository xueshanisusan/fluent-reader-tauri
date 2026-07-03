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

// The first manifest entry whose file is actually present on disk (guards
// against a manifest that lists a model the user deleted out-of-band).
fn installed_present(dir: &PathBuf) -> Result<Option<InstalledModel>, ModelError> {
    Ok(manifest::read(dir)?
        .installed
        .into_iter()
        .find(|e| dir.join(&e.file).is_file()))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    // The installed model in use, if any.
    pub installed: Option<InstalledModel>,
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
    let guard = state.runtime.lock().await;
    let (running, endpoint) = match guard.as_ref() {
        Some(rt) => (true, Some(runtime::endpoint_for(rt.port))),
        None => (false, None),
    };
    Ok(ModelStatus {
        installed,
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
    let installed = installed_present(&dir)
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
    let mut guard = state.runtime.lock().await;
    if let Some(rt) = guard.take() {
        let _ = rt.child.kill();
    }
    Ok(())
}
