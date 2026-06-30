//! Fever API client. Protocol mirrors the original Fluent Reader
//! (`src/scripts/models/services/fever.ts`): every call POSTs to
//! `{endpoint}?api{query}` with a form body `api_key={key}{post}`; the api_key
//! is `md5(username:password)`. Auth replies with `{ "auth": 0|1, ... }`.

use super::SyncError;
use md5::{Digest, Md5};
use reqwest::Client;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(30);

/// `md5(username:password)`, lowercase hex — the Fever bearer token.
pub fn api_key(username: &str, password: &str) -> String {
    let mut hasher = Md5::new();
    hasher.update(format!("{username}:{password}").as_bytes());
    hex::encode(hasher.finalize())
}

fn client() -> Result<Client, SyncError> {
    Client::builder()
        .timeout(TIMEOUT)
        .user_agent(concat!("fluent-reader-tauri/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| SyncError::Network { message: e.to_string() })
}

/// Issue a Fever API request. `query` is appended after `?api` (e.g. `&feeds`);
/// `post` is appended to the form body after `api_key=...` (e.g. `&mark=item...`).
pub async fn fetch_api(
    endpoint: &str,
    api_key: &str,
    query: &str,
    post: &str,
) -> Result<serde_json::Value, SyncError> {
    let url = format!("{endpoint}?api{query}");
    let body = format!("api_key={api_key}{post}");
    let resp = client()?
        .post(&url)
        .header("content-type", "application/x-www-form-urlencoded")
        .body(body)
        .send()
        .await
        .map_err(|e| SyncError::Network { message: e.to_string() })?;
    // reqwest is built without the `json` feature (see net.rs), so read text and
    // parse with serde_json directly.
    let text = resp
        .text()
        .await
        .map_err(|e| SyncError::Network { message: e.to_string() })?;
    serde_json::from_str(&text)
        .map_err(|e| SyncError::Parse { message: e.to_string() })
}

/// True when the server accepts the credentials (`auth == 1`).
pub async fn authenticate(endpoint: &str, api_key: &str) -> Result<bool, SyncError> {
    let json = fetch_api(endpoint, api_key, "", "").await?;
    Ok(json.get("auth").and_then(|v| v.as_i64()).unwrap_or(0) == 1)
}
