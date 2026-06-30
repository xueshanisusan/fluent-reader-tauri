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

/// A subscription as reported by the Fever `&feeds` endpoint.
#[derive(Debug)]
pub struct RemoteFeed {
    pub id: i64,
    pub url: String,
    pub title: String,
}

/// A `feeds_groups` entry: which feeds belong to a group.
#[derive(Debug)]
pub struct FeedGroup {
    pub group_id: i64,
    pub feed_ids: Vec<i64>,
}

/// A group (category) as reported by the Fever `&groups` endpoint.
#[derive(Debug)]
pub struct RemoteGroup {
    pub id: i64,
    pub title: String,
}

/// Result of the `&feeds` call: the subscription list plus the feed→group map
/// (Fever returns both in one response).
#[derive(Debug)]
pub struct FeedsResponse {
    pub feeds: Vec<RemoteFeed>,
    pub feed_groups: Vec<FeedGroup>,
}

/// Fetch the user's subscription list and feed→group map (`&feeds`).
pub async fn feeds(endpoint: &str, api_key: &str) -> Result<FeedsResponse, SyncError> {
    let json = fetch_api(endpoint, api_key, "&feeds", "").await?;
    let feeds_arr = json
        .get("feeds")
        .and_then(|v| v.as_array())
        .ok_or_else(|| SyncError::Parse {
            message: "missing 'feeds' array in response".into(),
        })?;
    let mut feeds = Vec::with_capacity(feeds_arr.len());
    for f in feeds_arr {
        let id = f.get("id").and_then(|v| v.as_i64());
        let url = f.get("url").and_then(|v| v.as_str());
        let title = f.get("title").and_then(|v| v.as_str()).unwrap_or("");
        if let (Some(id), Some(url)) = (id, url) {
            feeds.push(RemoteFeed {
                id,
                url: url.to_string(),
                title: title.to_string(),
            });
        }
    }
    // feeds_groups is optional; absence just means no grouping info.
    let mut feed_groups = Vec::new();
    if let Some(arr) = json.get("feeds_groups").and_then(|v| v.as_array()) {
        for g in arr {
            let group_id = g.get("group_id").and_then(|v| v.as_i64());
            let ids = g.get("feed_ids").and_then(|v| v.as_str());
            if let (Some(group_id), Some(ids)) = (group_id, ids) {
                let feed_ids = ids
                    .split(',')
                    .filter_map(|s| s.trim().parse::<i64>().ok())
                    .collect();
                feed_groups.push(FeedGroup { group_id, feed_ids });
            }
        }
    }
    Ok(FeedsResponse { feeds, feed_groups })
}

/// Fetch the user's group (category) titles (`&groups`).
pub async fn groups(endpoint: &str, api_key: &str) -> Result<Vec<RemoteGroup>, SyncError> {
    let json = fetch_api(endpoint, api_key, "&groups", "").await?;
    let arr = json
        .get("groups")
        .and_then(|v| v.as_array())
        .ok_or_else(|| SyncError::Parse {
            message: "missing 'groups' array in response".into(),
        })?;
    let mut out = Vec::with_capacity(arr.len());
    for g in arr {
        let id = g.get("id").and_then(|v| v.as_i64());
        let title = g.get("title").and_then(|v| v.as_str()).unwrap_or("");
        if let Some(id) = id {
            out.push(RemoteGroup {
                id,
                title: title.to_string(),
            });
        }
    }
    Ok(out)
}
