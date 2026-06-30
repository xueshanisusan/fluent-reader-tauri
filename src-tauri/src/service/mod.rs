//! Remote sync-service support. Fever first; the surface mirrors the original
//! Fluent Reader's `ServiceHooks`. Sync state reconciliation (read/starred) is a
//! multi-step DB op and will run in `pool.begin()` transactions in later PRs.

pub mod fever;
pub mod secrets;

use crate::commands::AppState;
use crate::repo;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use tauri::State;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SyncError {
    Network { message: String },
    Parse { message: String },
    Keyring { message: String },
    Db { message: String },
}

fn db_err(e: sqlx::Error) -> SyncError {
    SyncError::Db { message: e.to_string() }
}

/// Canonical key for matching a local source to a remote feed by URL. The
/// original Fluent Reader compares raw URLs, which leaves duplicates when the
/// same feed is written slightly differently (trailing slash, http vs https,
/// host case). We normalize to avoid that: scheme-agnostic, lowercased host,
/// trailing slash trimmed; path/query/port preserved.
fn normalize_url(raw: &str) -> String {
    match reqwest::Url::parse(raw) {
        Ok(u) => {
            let host = u
                .host_str()
                .unwrap_or("")
                .trim_end_matches('.')
                .to_ascii_lowercase();
            let port = u.port().map(|p| format!(":{p}")).unwrap_or_default();
            let path = u.path().trim_end_matches('/');
            let query = u.query().map(|q| format!("?{q}")).unwrap_or_default();
            format!("{host}{port}{path}{query}")
        }
        Err(_) => raw.trim().trim_end_matches('/').to_ascii_lowercase(),
    }
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncResult {
    pub added: u32,
    pub adopted: u32,
    pub removed: u32,
    pub grouped: u32,
}

/// Group-import inputs (the `&groups` titles + the `feeds_groups` map). When
/// passed to reconciliation, each synced source is assigned to the local group
/// matching its remote category, mirroring the original's one-time import.
pub struct GroupImport {
    pub groups: Vec<fever::RemoteGroup>,
    pub feed_groups: Vec<fever::FeedGroup>,
}

/// Sync subscriptions with the Fever service (updateSources). Reconciles the
/// local source list against the server's `&feeds` in a single transaction.
/// When `import_groups` is set, the server's categories are imported and synced
/// sources assigned to them (a one-time opt-in; the caller clears the flag
/// afterward). Item/read/star sync arrives in later PRs. The api_key is loaded
/// from the keychain; the endpoint comes from the caller's stored config.
#[tauri::command]
pub async fn service_sync(
    state: State<'_, AppState>,
    endpoint: String,
    import_groups: bool,
) -> Result<SyncResult, SyncError> {
    let endpoint = endpoint.trim().to_string();
    let api_key = secrets::load_fever_api_key()
        .map_err(|e| SyncError::Keyring { message: e.to_string() })?;
    update_sources(&state.pool, &endpoint, &api_key, import_groups).await
}

/// Reconcile local sources against the remote feed list, mirroring the original
/// Fluent Reader `updateSources`: match by exact URL; create new remote sources,
/// adopt URL-matching local ones (set service_ref + wipe their items), and
/// delete local remote-sources the server no longer lists. Optionally imports
/// the server's group structure.
async fn update_sources(
    pool: &sqlx::SqlitePool,
    endpoint: &str,
    api_key: &str,
    import_groups: bool,
) -> Result<SyncResult, SyncError> {
    let resp = fever::feeds(endpoint, api_key).await?;
    let group_import = if import_groups {
        let groups = fever::groups(endpoint, api_key).await?;
        Some(GroupImport {
            groups,
            feed_groups: resp.feed_groups,
        })
    } else {
        None
    };
    reconcile_sources(pool, &resp.feeds, group_import.as_ref()).await
}

/// Pure DB reconciliation step (no network) — split out so it can be tested
/// against an in-memory pool with synthetic feeds.
pub async fn reconcile_sources(
    pool: &sqlx::SqlitePool,
    remote: &[fever::RemoteFeed],
    group_import: Option<&GroupImport>,
) -> Result<SyncResult, SyncError> {
    let local = repo::sources::list(pool).await.map_err(db_err)?;

    // service_ref -> sid for local remote sources; url -> (sid, service_ref).
    let mut existing: HashMap<String, i64> = HashMap::new();
    let mut by_url: HashMap<String, (i64, Option<String>)> = HashMap::new();
    for s in &local {
        if let Some(r) = &s.service_ref {
            existing.insert(r.clone(), s.sid);
        }
        by_url.insert(normalize_url(&s.url), (s.sid, s.service_ref.clone()));
    }

    let mut added = 0u32;
    let mut adopted = 0u32;
    let mut removed = 0u32;
    let mut seen_refs: HashSet<String> = HashSet::new();
    // (feed id, sid) for every source the server still lists, so groups can be
    // assigned afterward (new, adopted, and reused alike).
    let mut feed_sids: Vec<(i64, i64)> = Vec::new();

    let mut tx = pool.begin().await.map_err(db_err)?;
    for f in remote {
        let ref_id = f.id.to_string();
        seen_refs.insert(ref_id.clone());
        if let Some(&sid) = existing.get(&ref_id) {
            feed_sids.push((f.id, sid)); // already mapped — reuse as-is
            continue;
        }
        match by_url.get(&normalize_url(&f.url)) {
            None => {
                let sid = repo::sources::create_remote_in_tx(&mut tx, &f.url, &f.title, &ref_id)
                    .await
                    .map_err(db_err)?;
                added += 1;
                feed_sids.push((f.id, sid));
            }
            Some((sid, sref)) if sref.as_deref() != Some(ref_id.as_str()) => {
                repo::sources::set_service_ref_in_tx(&mut tx, *sid, &ref_id)
                    .await
                    .map_err(db_err)?;
                repo::sources::delete_items_in_tx(&mut tx, *sid)
                    .await
                    .map_err(db_err)?;
                adopted += 1;
                feed_sids.push((f.id, *sid));
            }
            Some((sid, _)) => {
                // URL matches and service_ref already equal — reuse.
                feed_sids.push((f.id, *sid));
            }
        }
    }
    // Sources locally marked remote but absent from the server are removed.
    for (ref_id, sid) in &existing {
        if !seen_refs.contains(ref_id) {
            repo::sources::delete_in_tx(&mut tx, *sid).await.map_err(db_err)?;
            removed += 1;
        }
    }

    let mut grouped = 0u32;
    if let Some(gi) = group_import {
        grouped = assign_groups(&mut tx, &feed_sids, gi).await?;
    }

    tx.commit().await.map_err(db_err)?;

    Ok(SyncResult {
        added,
        adopted,
        removed,
        grouped,
    })
}

/// Assign each synced source to the local group matching its remote category.
/// Groups are created by title on demand (find-or-create), mirroring the
/// original. Returns the number of sources assigned to a group.
async fn assign_groups(
    tx: &mut sqlx::SqliteConnection,
    feed_sids: &[(i64, i64)],
    gi: &GroupImport,
) -> Result<u32, SyncError> {
    // remote group id -> title
    let title_by_gid: HashMap<i64, String> = gi
        .groups
        .iter()
        .map(|g| (g.id, g.title.trim().to_string()))
        .collect();
    // remote feed id -> group title
    let mut title_by_feed: HashMap<i64, String> = HashMap::new();
    for fg in &gi.feed_groups {
        if let Some(title) = title_by_gid.get(&fg.group_id) {
            if title.is_empty() {
                continue;
            }
            for fid in &fg.feed_ids {
                title_by_feed.insert(*fid, title.clone());
            }
        }
    }

    let mut gid_by_title: HashMap<String, i64> = HashMap::new();
    let mut grouped = 0u32;
    for (feed_id, sid) in feed_sids {
        let Some(title) = title_by_feed.get(feed_id) else {
            continue;
        };
        let gid = match gid_by_title.get(title) {
            Some(g) => *g,
            None => {
                let g = repo::groups::find_or_create_in_tx(&mut *tx, title)
                    .await
                    .map_err(db_err)?
                    .gid;
                gid_by_title.insert(title.clone(), g);
                g
            }
        };
        repo::sources::set_group_in_tx(&mut *tx, *sid, Some(gid))
            .await
            .map_err(db_err)?;
        grouped += 1;
    }
    Ok(grouped)
}
