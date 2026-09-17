//! Fever API client. Protocol mirrors the original Fluent Reader
//! (`src/scripts/models/services/fever.ts`): every call POSTs to
//! `{endpoint}?api{query}` with a form body `api_key={key}{post}`; the api_key
//! is `md5(username:password)`. Auth replies with `{ "auth": 0|1, ... }`.

use super::SyncError;
use md5::{Digest, Md5};
use reqwest::Client;
use std::collections::HashSet;
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

/// Transient send failures (connection reset/closed by an upstream proxy) are
/// retried this many times before giving up. A full sync makes many sequential
/// requests, so an occasional dropped connection shouldn't fail the whole run.
const MAX_RETRIES: usize = 3;

/// POST a Fever request over the given `client`, retrying transient send errors
/// with a short backoff. Reusing one client across a paginated pull keeps the
/// connection alive instead of opening a fresh TCP+TLS handshake per page (which
/// upstream proxies drop under rapid churn). `query` is appended after `?api`
/// (e.g. `&feeds`); `post` after the `api_key=...` body (e.g. `&mark=item...`).
async fn post_api(
    client: &Client,
    endpoint: &str,
    api_key: &str,
    query: &str,
    post: &str,
) -> Result<serde_json::Value, SyncError> {
    let url = format!("{endpoint}?api{query}");
    let body = format!("api_key={api_key}{post}");
    let mut last_err: Option<String> = None;
    for attempt in 1..=MAX_RETRIES {
        match client
            .post(&url)
            .header("content-type", "application/x-www-form-urlencoded")
            .body(body.clone())
            .send()
            .await
        {
            Ok(resp) => {
                // reqwest is built without the `json` feature (see net.rs), so
                // read text and parse with serde_json directly.
                let status = resp.status();
                let text = resp
                    .text()
                    .await
                    .map_err(|e| SyncError::Network { message: e.to_string() })?;
                if !status.is_success() {
                    // Many servers answer a wrong endpoint/bad credentials with an
                    // empty (or HTML) body, which otherwise surfaces as an opaque
                    // "EOF while parsing a value" from serde_json below.
                    return Err(SyncError::Network {
                        message: format!(
                            "server returned HTTP {status} for {url}{}",
                            if text.trim().is_empty() {
                                String::new()
                            } else {
                                format!(": {}", text.trim().chars().take(200).collect::<String>())
                            }
                        ),
                    });
                }
                if text.trim().is_empty() {
                    return Err(SyncError::Parse {
                        message: format!(
                            "server returned an empty response body for {url} (check the endpoint URL)"
                        ),
                    });
                }
                return serde_json::from_str(&text).map_err(|e| SyncError::Parse {
                    message: format!(
                        "{e} (response: {})",
                        text.trim().chars().take(200).collect::<String>()
                    ),
                });
            }
            Err(e) => {
                last_err = Some(e.to_string());
                if attempt < MAX_RETRIES {
                    let backoff = Duration::from_millis(300 * attempt as u64);
                    eprintln!(
                        "[fever] send failed (attempt {attempt}/{MAX_RETRIES}), retrying in {backoff:?}: {e}"
                    );
                    tokio::time::sleep(backoff).await;
                }
            }
        }
    }
    Err(SyncError::Network {
        message: last_err.unwrap_or_else(|| "request failed".into()),
    })
}

/// Issue a one-shot Fever API request (builds a client per call). Item pulls use
/// `post_api` directly with a shared client — see `items`.
pub async fn fetch_api(
    endpoint: &str,
    api_key: &str,
    query: &str,
    post: &str,
) -> Result<serde_json::Value, SyncError> {
    let client = client()?;
    post_api(&client, endpoint, api_key, query, post).await
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
        let id = as_int(f.get("id"));
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
            let group_id = as_int(g.get("group_id"));
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

/// An article as reported by the Fever `&items` endpoint.
#[derive(Debug, Clone)]
pub struct FeverItem {
    pub id: i64,
    pub feed_id: i64,
    pub title: String,
    pub url: String,
    pub html: String,
    pub author: String,
    /// Unix seconds.
    pub created_on_time: i64,
    pub is_read: bool,
    pub is_saved: bool,
}

// The original starts pagination at Number.MAX_SAFE_INTEGER and falls back to
// 2^31-1 for TTRSS's Fever plugin, which can't handle larger max_id values.
const MAX_SAFE: i64 = 9_007_199_254_740_991;
const I32_MAX: i64 = 2_147_483_647;
/// Fever returns at most this many items per `&items` page.
const PAGE_SIZE: usize = 50;

/// Coerce a Fever integer field. Usually a JSON integer, but some servers encode
/// ids/timestamps as strings ("12345") or floats. `as_i64()` alone returns None
/// for both, which stalls pagination (min never decreases) — accept all three.
fn as_int(v: Option<&serde_json::Value>) -> Option<i64> {
    match v {
        Some(serde_json::Value::Number(n)) => {
            n.as_i64().or_else(|| n.as_f64().map(|f| f as i64))
        }
        Some(serde_json::Value::String(s)) => s.trim().parse::<i64>().ok(),
        _ => None,
    }
}

/// Coerce a Fever boolean field (sent as 0/1, sometimes a real bool or string).
fn truthy(v: Option<&serde_json::Value>) -> bool {
    match v {
        Some(serde_json::Value::Bool(b)) => *b,
        Some(serde_json::Value::Number(n)) => n.as_i64().map_or(false, |i| i != 0),
        Some(serde_json::Value::String(s)) => s == "1" || s.eq_ignore_ascii_case("true"),
        _ => false,
    }
}

fn parse_item(v: &serde_json::Value) -> Option<FeverItem> {
    let id = as_int(v.get("id"))?;
    let feed_id = as_int(v.get("feed_id"))?;
    let s = |k: &str| v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    Some(FeverItem {
        id,
        feed_id,
        title: s("title"),
        url: s("url"),
        html: s("html"),
        author: s("author"),
        created_on_time: as_int(v.get("created_on_time")).unwrap_or(0),
        is_read: truthy(v.get("is_read")),
        is_saved: truthy(v.get("is_saved")),
    })
}

/// Incrementally pull items newer than `last_id`, mirroring the original
/// `services/fever.ts::fetchItems`. Fever has no "since id" query, so we page
/// BACKWARDS with `&items&max_id=N` (each page is ≤ `PAGE_SIZE`, ordered desc by
/// id), keeping only items with `id > last_id`. Stops when the page's smallest id
/// drops to/below `last_id`, a short (final) page arrives, or `fetch_limit` is
/// reached. `use_int32` handles TTRSS's Fever plugin, which returns nothing for a
/// max_id above 2^31-1: if the very first page (at MAX_SAFE) is empty we flip the
/// flag and retry at I32_MAX. Returns the collected items plus the advanced
/// cursor (`new_last_id`, `new_use_int32`) for the caller to persist.
pub async fn items(
    endpoint: &str,
    api_key: &str,
    last_id: i64,
    fetch_limit: usize,
    use_int32: bool,
) -> Result<(Vec<FeverItem>, i64, bool), SyncError> {
    // One client for the whole pull: sequential pages reuse the keep-alive
    // connection instead of a fresh handshake each time.
    let client = client()?;
    let mut collected: Vec<FeverItem> = Vec::new();
    let mut use_int32 = use_int32;
    let mut min: i64 = if use_int32 { I32_MAX } else { MAX_SAFE };

    // Defensive backstop: even at fetch_limit=2000 a well-behaved server needs
    // ≤41 pages. A server that ignores max_id (min never decreases) would
    // otherwise spin until fetch_limit; cap the page count so sync can't hang.
    let max_pages = (fetch_limit / PAGE_SIZE).saturating_add(4).max(8);
    let mut pages = 0usize;

    loop {
        pages += 1;
        if pages > max_pages {
            eprintln!(
                "[fever::items] page cap {max_pages} hit (min={min}, collected={}); stopping",
                collected.len()
            );
            break;
        }
        let json = post_api(&client, endpoint, api_key, &format!("&items&max_id={min}"), "").await?;
        let arr = json
            .get("items")
            .and_then(|v| v.as_array())
            .ok_or_else(|| SyncError::Parse {
                message: "missing 'items' array in response".into(),
            })?;
        let page_len = arr.len();

        // First page empty at MAX_SAFE → TTRSS int32 quirk: retry at I32_MAX.
        let retried = page_len == 0 && min == MAX_SAFE;
        if retried {
            use_int32 = true;
            min = I32_MAX;
        } else {
            // min reduces over EVERY id in the page (not just the kept ones), so
            // the next max_id walks strictly backwards even when this page is all
            // already-seen items.
            let mut page_min = min;
            for v in arr {
                let Some(id) = as_int(v.get("id")) else {
                    continue;
                };
                page_min = page_min.min(id);
                if id > last_id {
                    if let Some(it) = parse_item(v) {
                        collected.push(it);
                    }
                }
            }
            min = page_min;
        }

        let more = min > last_id
            && (retried || page_len >= PAGE_SIZE)
            && collected.len() < fetch_limit;
        if !more {
            break;
        }
    }

    let new_last_id = collected.iter().map(|i| i.id).fold(last_id, i64::max);
    eprintln!(
        "[fever::items] done: {} items in {pages} page(s), last_id {last_id} -> {new_last_id}",
        collected.len()
    );
    Ok((collected, new_last_id, use_int32))
}

/// A read/star mutation to push to the server (`&mark=item&as=...`). Deserialized
/// straight from the frontend command payload ("read"|"unread"|"saved"|"unsaved").
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Mark {
    Read,
    Unread,
    Saved,
    Unsaved,
}

impl Mark {
    fn as_str(self) -> &'static str {
        match self {
            Mark::Read => "read",
            Mark::Unread => "unread",
            Mark::Saved => "saved",
            Mark::Unsaved => "unsaved",
        }
    }
}

/// Push a single item's read/star state to the server (`&mark=item&as=…&id=…`).
/// Best-effort — the caller treats failures as non-fatal (the next syncItems
/// pull reconciles), matching the original's `markItem` try/catch.
pub async fn mark_item(
    endpoint: &str,
    api_key: &str,
    service_ref: &str,
    mark: Mark,
) -> Result<(), SyncError> {
    fetch_api(
        endpoint,
        api_key,
        "",
        &format!("&mark=item&as={}&id={service_ref}", mark.as_str()),
    )
    .await?;
    Ok(())
}

/// Mark an entire feed read up to `before` (Unix seconds) — the original's
/// markAllRead optimization (`&mark=feed&as=read&id=…&before=…`).
pub async fn mark_feed_read(
    endpoint: &str,
    api_key: &str,
    service_ref: &str,
    before_secs: i64,
) -> Result<(), SyncError> {
    fetch_api(
        endpoint,
        api_key,
        "",
        &format!("&mark=feed&as=read&id={service_ref}&before={before_secs}"),
    )
    .await?;
    Ok(())
}

/// Parse a Fever comma-separated id string field (e.g. `unread_item_ids`) into a
/// set of ids. Empty/absent → empty set.
fn parse_id_set(json: &serde_json::Value, field: &str) -> Result<HashSet<String>, SyncError> {
    let s = json
        .get(field)
        .and_then(|v| v.as_str())
        .ok_or_else(|| SyncError::Parse {
            message: format!("missing '{field}' string in response"),
        })?;
    Ok(s.split(',')
        .map(str::trim)
        .filter(|x| !x.is_empty())
        .map(String::from)
        .collect())
}

/// The server's authoritative set of unread item ids (`&unread_item_ids`).
pub async fn unread_item_ids(endpoint: &str, api_key: &str) -> Result<HashSet<String>, SyncError> {
    let json = fetch_api(endpoint, api_key, "&unread_item_ids", "").await?;
    parse_id_set(&json, "unread_item_ids")
}

/// The server's authoritative set of saved (starred) item ids (`&saved_item_ids`).
pub async fn saved_item_ids(endpoint: &str, api_key: &str) -> Result<HashSet<String>, SyncError> {
    let json = fetch_api(endpoint, api_key, "&saved_item_ids", "").await?;
    parse_id_set(&json, "saved_item_ids")
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
        let id = as_int(g.get("id"));
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn as_int_accepts_int_float_and_string() {
        assert_eq!(as_int(Some(&json!(12345))), Some(12345));
        assert_eq!(as_int(Some(&json!(12345.0))), Some(12345));
        // String ids are the quirk that stalled pagination before this fix.
        assert_eq!(as_int(Some(&json!("12345"))), Some(12345));
        assert_eq!(as_int(Some(&json!(" 42 "))), Some(42));
        assert_eq!(as_int(Some(&json!("nope"))), None);
        assert_eq!(as_int(None), None);
    }

    #[test]
    fn truthy_accepts_int_bool_and_string() {
        assert!(truthy(Some(&json!(1))));
        assert!(!truthy(Some(&json!(0))));
        assert!(truthy(Some(&json!(true))));
        assert!(truthy(Some(&json!("1"))));
        assert!(truthy(Some(&json!("true"))));
        assert!(!truthy(Some(&json!("0"))));
        assert!(!truthy(None));
    }

    #[test]
    fn parse_item_handles_string_encoded_fields() {
        // A server that sends id/feed_id/created_on_time/is_read as strings.
        let v = json!({
            "id": "987",
            "feed_id": "3",
            "title": "Hi",
            "url": "https://x/1",
            "html": "<p>body</p>",
            "author": "me",
            "created_on_time": "1700000000",
            "is_read": "1",
            "is_saved": "0",
        });
        let it = parse_item(&v).expect("parses");
        assert_eq!(it.id, 987);
        assert_eq!(it.feed_id, 3);
        assert_eq!(it.created_on_time, 1_700_000_000);
        assert!(it.is_read);
        assert!(!it.is_saved);
    }
}
