//! Remote sync-service support. Fever first; the surface mirrors the original
//! Fluent Reader's `ServiceHooks`. Sync state reconciliation (read/starred) is a
//! multi-step DB op and will run in `pool.begin()` transactions in later PRs.

pub mod fever;
pub mod secrets;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SyncError {
    Network { message: String },
    Parse { message: String },
    Keyring { message: String },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeverAuthInput {
    pub endpoint: String,
    pub username: String,
    pub password: String,
}

/// Verify Fever credentials and, on success, persist the derived api_key to the
/// OS keychain. Returns whether the server accepted the credentials. The api_key
/// is never returned to the frontend — only the non-secret config (endpoint,
/// username) is stored in the settings store by the caller.
#[tauri::command]
pub async fn service_authenticate(input: FeverAuthInput) -> Result<bool, SyncError> {
    let api_key = fever::api_key(&input.username, &input.password);
    let ok = fever::authenticate(input.endpoint.trim(), &api_key).await?;
    if ok {
        secrets::store_fever_api_key(&api_key)
            .map_err(|e| SyncError::Keyring { message: e.to_string() })?;
    }
    Ok(ok)
}

/// Forget the stored Fever credentials (called when the user removes the service).
#[tauri::command]
pub async fn service_forget() -> Result<(), SyncError> {
    secrets::delete_fever_api_key()
        .map_err(|e| SyncError::Keyring { message: e.to_string() })
}
