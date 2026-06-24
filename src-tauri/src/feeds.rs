// Feed ingestion: per-source fetch → feed-rs parse → dedup insert + cache header
// update, atomic within a single tx. Frontend orchestrates concurrency across
// sources via Promise.all; this command owns the single-source pipeline.

use crate::commands::AppState;
use crate::models::*;
use crate::net::{self, FetchRequest};
use crate::repo;
use base64::Engine;
use feed_rs::parser;
use std::collections::HashMap;
use tauri::State;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn find_header<'a>(headers: &'a [(String, String)], key: &str) -> Option<&'a str> {
    headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(key))
        .map(|(_, v)| v.as_str())
}

fn entry_to_new_item(source_id: i64, entry: feed_rs::model::Entry) -> Option<NewItem> {
    let link = entry.links.first().map(|l| l.href.clone())?;
    let title = entry
        .title
        .map(|t| t.content)
        .unwrap_or_else(|| "(untitled)".to_string());
    let date_ms = entry
        .published
        .or(entry.updated)
        .map(|d| d.timestamp_millis())
        .unwrap_or_else(now_ms);
    let content = entry
        .content
        .and_then(|c| c.body)
        .or_else(|| entry.summary.as_ref().map(|s| s.content.clone()));
    let snippet = entry.summary.map(|s| s.content);
    let creator = entry
        .authors
        .into_iter()
        .next()
        .map(|p| p.name);
    let thumb = entry
        .media
        .into_iter()
        .flat_map(|m| m.thumbnails)
        .next()
        .map(|t| t.image.uri);
    // feed-rs always sets entry.id (synthesizes a stable hash when the feed
    // omits <guid>/atom:id). Empty string is theoretical but normalize to None.
    let guid = if entry.id.is_empty() { None } else { Some(entry.id) };

    Some(NewItem {
        source_id,
        title,
        link,
        date_ms,
        thumb,
        content,
        snippet,
        creator,
        guid,
        has_read: false,
        starred: false,
        hidden: false,
        notify: false,
    })
}

/// Pure ingest: fetches, parses, applies rules, persists. Returns the
/// outcome plus the source name and the subset of items that were both
/// freshly inserted (i.e. not dedup-skipped) AND flagged `notify=true`
/// by a rule. The `notify::dispatch` step lives in the AppHandle-bound
/// wrapper below; this function is `AppHandle`-free so tests can call
/// it without a Tauri runtime.
pub async fn ingest_core(
    pool: &sqlx::SqlitePool,
    sid: i64,
) -> Result<(IngestionOutcome, String, Vec<NewItem>), IngestionError> {
    let source = repo::sources::get(pool, sid)
        .await
        .map_err(|e| IngestionError::Db { message: e.to_string() })?;

    let mut headers: HashMap<String, String> = HashMap::new();
    if let Some(etag) = source.etag.as_deref() {
        headers.insert("If-None-Match".to_string(), etag.to_string());
    }
    if let Some(lm) = source.last_modified.as_deref() {
        headers.insert("If-Modified-Since".to_string(), lm.to_string());
    }

    let resp = net::fetch(FetchRequest {
        url: source.url.clone(),
        method: Some("GET".to_string()),
        headers: if headers.is_empty() { None } else { Some(headers) },
        timeout_ms: None,
    })
    .await
    .map_err(|e| IngestionError::Network { message: e.to_string() })?;

    let now = now_ms();

    if resp.status == 304 {
        let mut tx = pool
            .begin()
            .await
            .map_err(|e| IngestionError::Db { message: e.to_string() })?;
        repo::sources::set_last_fetched_in_tx(&mut tx, sid, now)
            .await
            .map_err(|e| IngestionError::Db { message: e.to_string() })?;
        tx.commit()
            .await
            .map_err(|e| IngestionError::Db { message: e.to_string() })?;
        return Ok((
            IngestionOutcome::NotModified { final_url: resp.final_url },
            source.name,
            Vec::new(),
        ));
    }

    if !(200..300).contains(&resp.status) {
        return Err(IngestionError::Network {
            message: format!("http {}", resp.status),
        });
    }

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&resp.body_base64)
        .map_err(|e| IngestionError::Network { message: e.to_string() })?;

    let feed = parser::parse(bytes.as_slice())
        .map_err(|e| IngestionError::Parse { message: e.to_string() })?;

    let mut items: Vec<NewItem> = feed
        .entries
        .into_iter()
        .filter_map(|e| entry_to_new_item(sid, e))
        .collect();

    // Load rules and stamp action fields on parsed items BEFORE opening the
    // write tx. Reads inside the tx would deadlock against max_connections=1
    // pools (see opml.rs::import for the same pattern).
    let rules = repo::rules::list_for_source(pool, sid)
        .await
        .map_err(|e| IngestionError::Db { message: e.to_string() })?;
    crate::rules::apply_all(&rules, &mut items);

    let etag = find_header(&resp.headers, "etag").map(|s| s.to_string());
    let last_modified = find_header(&resp.headers, "last-modified").map(|s| s.to_string());

    let mut tx = pool
        .begin()
        .await
        .map_err(|e| IngestionError::Db { message: e.to_string() })?;
    let (inserted, skipped, mask) = repo::items::insert_dedup_in_tx(&mut tx, &items)
        .await
        .map_err(|e| IngestionError::Db { message: e.to_string() })?;
    repo::sources::set_cache_headers_in_tx(
        &mut tx,
        sid,
        etag.as_deref(),
        last_modified.as_deref(),
    )
    .await
    .map_err(|e| IngestionError::Db { message: e.to_string() })?;
    repo::sources::set_last_fetched_in_tx(&mut tx, sid, now)
        .await
        .map_err(|e| IngestionError::Db { message: e.to_string() })?;
    tx.commit()
        .await
        .map_err(|e| IngestionError::Db { message: e.to_string() })?;

    let notify_items: Vec<NewItem> = items
        .into_iter()
        .zip(mask.iter())
        .filter_map(|(it, ins)| if *ins && it.notify { Some(it) } else { None })
        .collect();

    Ok((
        IngestionOutcome::Updated {
            inserted,
            skipped,
            final_url: resp.final_url,
        },
        source.name,
        notify_items,
    ))
}

/// Thin wrapper around `ingest_core` that fires OS notifications for any
/// rule-flagged items the core surfaced. Used by the `sources_ingest`
/// command; tests should call `ingest_core` directly.
pub async fn ingest(
    app: &tauri::AppHandle,
    pool: &sqlx::SqlitePool,
    sid: i64,
) -> Result<IngestionOutcome, IngestionError> {
    let (outcome, source_name, notify_items) = ingest_core(pool, sid).await?;
    crate::notify::dispatch(app, &source_name, &notify_items);
    Ok(outcome)
}

#[tauri::command]
pub async fn sources_ingest(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    sid: i64,
) -> Result<IngestionOutcome, IngestionError> {
    ingest(&app, &state.pool, sid).await
}

// Feed auto-discovery: given an arbitrary URL, return the feed URLs we can ingest.
//   • If the response body itself parses as a feed → return one entry pointing
//     at the final (post-redirect) URL.
//   • Else parse as HTML and pull <link rel="alternate" type="application/{rss,atom}+xml">
//     out of <head>. Relative hrefs resolve against the final URL.

const FEED_TYPES: &[&str] = &[
    "application/rss+xml",
    "application/atom+xml",
    "application/feed+json",
    "application/json",
];

fn looks_like_feed_type(t: &str) -> bool {
    let t = t.to_ascii_lowercase();
    FEED_TYPES.iter().any(|wanted| t.contains(wanted))
}

pub async fn discover(input_url: &str) -> Result<Vec<DiscoveredFeed>, DiscoveryError> {
    let resp = net::fetch(FetchRequest {
        url: input_url.to_string(),
        method: Some("GET".to_string()),
        headers: None,
        timeout_ms: None,
    })
    .await
    .map_err(|e| DiscoveryError::Network { message: e.to_string() })?;

    if !(200..300).contains(&resp.status) {
        return Err(DiscoveryError::Network {
            message: format!("http {}", resp.status),
        });
    }

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&resp.body_base64)
        .map_err(|e| DiscoveryError::Network { message: e.to_string() })?;

    // Cheap probe: does this parse as a feed? If yes, the URL itself is the answer.
    if let Ok(feed) = parser::parse(bytes.as_slice()) {
        let title = feed.title.map(|t| t.content);
        return Ok(vec![DiscoveredFeed {
            url: resp.final_url,
            title,
        }]);
    }

    // Otherwise treat as HTML.
    let html = String::from_utf8_lossy(&bytes);
    let base = reqwest::Url::parse(&resp.final_url).ok();
    let document = scraper::Html::parse_document(&html);
    let selector = scraper::Selector::parse("head link[rel~=\"alternate\"]")
        .expect("static selector parses");

    let mut out = Vec::new();
    for el in document.select(&selector) {
        let attrs = el.value();
        let typ = attrs.attr("type").unwrap_or("");
        if !looks_like_feed_type(typ) {
            continue;
        }
        let href = match attrs.attr("href") {
            Some(h) => h.trim(),
            None => continue,
        };
        if href.is_empty() {
            continue;
        }
        let resolved = match base.as_ref() {
            Some(b) => b.join(href).map(|u| u.to_string()).unwrap_or_else(|_| href.to_string()),
            None => href.to_string(),
        };
        let title = attrs.attr("title").map(|s| s.to_string());
        out.push(DiscoveredFeed { url: resolved, title });
    }

    if out.is_empty() {
        return Err(DiscoveryError::NotFound {
            message: "no feed link found in document".to_string(),
        });
    }

    Ok(out)
}

#[tauri::command]
pub async fn feeds_discover(
    url: String,
) -> Result<Vec<DiscoveredFeed>, DiscoveryError> {
    discover(&url).await
}
