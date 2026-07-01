//! Remote sync-service support. Fever first; the surface mirrors the original
//! Fluent Reader's `ServiceHooks`. Sync state reconciliation (read/starred) is a
//! multi-step DB op and will run in `pool.begin()` transactions in later PRs.

pub mod fever;
pub mod secrets;

use crate::commands::AppState;
use crate::models::{NewItem, SourceRule};
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
    /// Local read/star states changed to match the server (syncItems).
    pub reconciled: u32,
    /// Items freshly inserted by the item pull (fetchItems).
    pub fetched: u32,
    /// Advanced incremental-fetch cursor; the caller persists these into the
    /// stored FeverConfigs so the next sync only pulls newer items.
    pub last_id: i64,
    pub use_int32: bool,
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
    fetch_limit: u32,
    last_id: i64,
    use_int32: bool,
) -> Result<SyncResult, SyncError> {
    let endpoint = endpoint.trim().to_string();
    let api_key = secrets::load_fever_api_key()
        .map_err(|e| SyncError::Keyring { message: e.to_string() })?;
    match sync_inner(
        &state.pool,
        &endpoint,
        &api_key,
        import_groups,
        fetch_limit,
        last_id,
        use_int32,
    )
    .await
    {
        Ok(r) => Ok(r),
        Err(e) => {
            eprintln!("[service_sync] failed: {e:?}");
            Err(e)
        }
    }
}

async fn sync_inner(
    pool: &sqlx::SqlitePool,
    endpoint: &str,
    api_key: &str,
    import_groups: bool,
    fetch_limit: u32,
    last_id: i64,
    use_int32: bool,
) -> Result<SyncResult, SyncError> {
    // Mirror the original syncWithService order: updateSources → syncItems →
    // fetchItems. syncItems reconciles read/star of existing items (server is
    // authority; local changes were already pushed in real time); fetchItems
    // then inserts new items with their server-side read/star already correct.
    let mut result = update_sources(pool, endpoint, api_key, import_groups).await?;
    result.reconciled = sync_items(pool, endpoint, api_key).await?;
    let fo = fetch_items(pool, endpoint, api_key, fetch_limit as usize, last_id, use_int32).await?;
    result.fetched = fo.fetched;
    result.last_id = fo.last_id;
    result.use_int32 = fo.use_int32;
    Ok(result)
}

/// Push a single item's read/star state to the service. Best-effort: called by
/// the frontend after a local mark succeeds, errors are the caller's to swallow.
#[tauri::command]
pub async fn service_mark(
    endpoint: String,
    service_ref: String,
    mark: fever::Mark,
) -> Result<(), SyncError> {
    let api_key = secrets::load_fever_api_key()
        .map_err(|e| SyncError::Keyring { message: e.to_string() })?;
    fever::mark_item(endpoint.trim(), &api_key, &service_ref, mark).await
}

/// Mark an entire source read up to `before_ms` (the markAllRead optimization).
#[tauri::command]
pub async fn service_mark_feed_read(
    endpoint: String,
    service_ref: String,
    before_ms: i64,
) -> Result<(), SyncError> {
    let api_key = secrets::load_fever_api_key()
        .map_err(|e| SyncError::Keyring { message: e.to_string() })?;
    // Original: floor(time/1000) + 1 second, so "before now" includes now.
    let before_secs = before_ms / 1000 + 1;
    fever::mark_feed_read(endpoint.trim(), &api_key, &service_ref, before_secs).await
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

    // syncItems / fetch_items fields are filled in by service_sync's later steps;
    // source reconciliation on its own reports zero and an unchanged cursor.
    Ok(SyncResult {
        added,
        adopted,
        removed,
        grouped,
        reconciled: 0,
        fetched: 0,
        last_id: 0,
        use_int32: false,
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

/// Outcome of an item pull: how many were freshly inserted plus the advanced
/// incremental-fetch cursor to persist.
pub struct FetchOutcome {
    pub fetched: u32,
    pub last_id: i64,
    pub use_int32: bool,
}

/// Plain-text snippet from item HTML, mirroring the original's
/// `htmlDecode(html).trim()` (DOM textContent). Entities are decoded by the
/// parser; we additionally collapse runs of whitespace so list snippets read
/// cleanly. Builds and drops a `scraper::Html` internally — keep it free of
/// `.await` so the `!Send` parser never crosses an await point.
fn html_to_snippet(html: &str) -> String {
    let frag = scraper::Html::parse_fragment(html);
    let text: String = frag.root_element().text().collect();
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Pull items newer than the cursor from the Fever service and persist them.
/// Thin network wrapper around `fever::items` + the pure `ingest_items` step.
async fn fetch_items(
    pool: &sqlx::SqlitePool,
    endpoint: &str,
    api_key: &str,
    fetch_limit: usize,
    last_id: i64,
    use_int32: bool,
) -> Result<FetchOutcome, SyncError> {
    let (remote, new_last_id, new_use_int32) =
        fever::items(endpoint, api_key, last_id, fetch_limit, use_int32).await?;
    let fetched = ingest_items(pool, &remote).await?;
    Ok(FetchOutcome {
        fetched,
        last_id: new_last_id,
        use_int32: new_use_int32,
    })
}

/// Pure DB step (no network) — map remote items onto local sources by
/// service_ref, apply per-source rules, and dedup-insert in one transaction.
/// Split out so it's testable against an in-memory pool with synthetic items.
/// Items whose feed has no local source (not yet reconciled) are dropped;
/// updateSources runs before this in a full sync, so that's only transient.
pub async fn ingest_items(
    pool: &sqlx::SqlitePool,
    remote: &[fever::FeverItem],
) -> Result<u32, SyncError> {
    if remote.is_empty() {
        return Ok(0);
    }

    // remote feed id -> local sid, via service_ref.
    let local = repo::sources::list(pool).await.map_err(db_err)?;
    let mut sid_by_ref: HashMap<String, i64> = HashMap::new();
    for s in &local {
        if let Some(r) = &s.service_ref {
            sid_by_ref.insert(r.clone(), s.sid);
        }
    }

    // Build NewItems grouped by source. The snippet strip uses scraper, so this
    // loop must stay synchronous (no .await) — it is.
    let mut by_source: HashMap<i64, Vec<NewItem>> = HashMap::new();
    for it in remote {
        let Some(&sid) = sid_by_ref.get(&it.feed_id.to_string()) else {
            continue;
        };
        by_source.entry(sid).or_default().push(NewItem {
            source_id: sid,
            title: it.title.clone(),
            link: it.url.clone(),
            date_ms: it.created_on_time.saturating_mul(1000),
            thumb: None,
            content: Some(it.html.clone()),
            snippet: Some(html_to_snippet(&it.html)),
            creator: if it.author.is_empty() {
                None
            } else {
                Some(it.author.clone())
            },
            guid: None,
            service_ref: Some(it.id.to_string()),
            has_read: it.is_read,
            starred: it.is_saved,
            hidden: false,
            notify: false,
        });
    }

    // Load rules per source BEFORE opening the tx (reads inside the tx deadlock
    // against the single-connection pool — same constraint as feeds::ingest_core).
    let mut rules_by_source: HashMap<i64, Vec<SourceRule>> = HashMap::new();
    for sid in by_source.keys() {
        let rules = repo::rules::list_for_source(pool, *sid)
            .await
            .map_err(db_err)?;
        rules_by_source.insert(*sid, rules);
    }
    for (sid, items) in by_source.iter_mut() {
        if let Some(rules) = rules_by_source.get(sid) {
            crate::rules::apply_all(rules, items);
        }
    }

    let mut tx = pool.begin().await.map_err(db_err)?;
    let mut fetched = 0u32;
    for items in by_source.values() {
        let (inserted, _skipped, _mask) = repo::items::insert_dedup_in_tx(&mut tx, items)
            .await
            .map_err(db_err)?;
        fetched += inserted as u32;
    }
    tx.commit().await.map_err(db_err)?;

    Ok(fetched)
}

/// Reconcile local read/star state with the service (syncItems). Fetches the
/// server's authoritative unread + saved id sets, then forces local items to
/// match. The push direction (local → server) happens in real time via
/// `service_mark`, so here the server is the source of truth. Returns the number
/// of local rows changed.
async fn sync_items(
    pool: &sqlx::SqlitePool,
    endpoint: &str,
    api_key: &str,
) -> Result<u32, SyncError> {
    // The original issues both id-set requests concurrently (Promise.all).
    let (unread, saved) = tokio::try_join!(
        fever::unread_item_ids(endpoint, api_key),
        fever::saved_item_ids(endpoint, api_key),
    )?;
    reconcile_read_star(pool, &unread, &saved).await
}

/// Pure DB step (no network) — force local items' read/star to match the
/// server's `unread`/`saved` id sets, mirroring the original `service.ts`
/// syncItems reconciliation. Split out so it's testable against an in-memory
/// pool. Returns the number of rows actually changed.
pub async fn reconcile_read_star(
    pool: &sqlx::SqlitePool,
    unread: &HashSet<String>,
    saved: &HashSet<String>,
) -> Result<u32, SyncError> {
    // Locally-divergent candidates: items backed by the service that are
    // locally unread or locally starred.
    let rows = repo::items::list_synced_read_star(pool).await.map_err(db_err)?;

    // Consume the server sets as we match: what remains after the loop is
    // "server says X but no local row reflected it" and drives the inverse fix.
    let mut unread_remaining = unread.clone();
    let mut saved_remaining = saved.clone();
    let mut set_read: Vec<String> = Vec::new(); // locally-unread → server-read
    let mut set_unstar: Vec<String> = Vec::new(); // locally-starred → server-unstarred

    for (service_ref, has_read, starred) in &rows {
        if !has_read && !unread_remaining.remove(service_ref) {
            // Locally unread, but the server doesn't list it as unread → read.
            set_read.push(service_ref.clone());
        }
        if *starred && !saved_remaining.remove(service_ref) {
            // Locally starred, but the server doesn't list it as saved → unstar.
            set_unstar.push(service_ref.clone());
        }
    }

    let mut changed = 0u32;
    let mut tx = pool.begin().await.map_err(db_err)?;
    for r in &set_read {
        changed += repo::items::set_read_by_service_ref_in_tx(&mut tx, r, true)
            .await
            .map_err(db_err)? as u32;
    }
    // Server lists these as unread but no local unread row matched → set unread.
    for r in &unread_remaining {
        changed += repo::items::set_read_by_service_ref_in_tx(&mut tx, r, false)
            .await
            .map_err(db_err)? as u32;
    }
    for r in &set_unstar {
        changed += repo::items::set_starred_by_service_ref_in_tx(&mut tx, r, false)
            .await
            .map_err(db_err)? as u32;
    }
    // Server lists these as saved but no local starred row matched → set starred.
    for r in &saved_remaining {
        changed += repo::items::set_starred_by_service_ref_in_tx(&mut tx, r, true)
            .await
            .map_err(db_err)? as u32;
    }
    tx.commit().await.map_err(db_err)?;

    Ok(changed)
}
