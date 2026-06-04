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

    Some(NewItem {
        source_id,
        title,
        link,
        date_ms,
        thumb,
        content,
        snippet,
        creator,
    })
}

pub async fn ingest(
    pool: &sqlx::SqlitePool,
    sid: i64,
) -> Result<IngestionOutcome, IngestionError> {
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
        return Ok(IngestionOutcome::NotModified { final_url: resp.final_url });
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

    let items: Vec<NewItem> = feed
        .entries
        .into_iter()
        .filter_map(|e| entry_to_new_item(sid, e))
        .collect();

    let etag = find_header(&resp.headers, "etag").map(|s| s.to_string());
    let last_modified = find_header(&resp.headers, "last-modified").map(|s| s.to_string());

    let mut tx = pool
        .begin()
        .await
        .map_err(|e| IngestionError::Db { message: e.to_string() })?;
    let (inserted, skipped) = repo::items::insert_dedup_in_tx(&mut tx, &items)
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

    Ok(IngestionOutcome::Updated {
        inserted,
        skipped,
        final_url: resp.final_url,
    })
}

#[tauri::command]
pub async fn sources_ingest(
    state: State<'_, AppState>,
    sid: i64,
) -> Result<IngestionOutcome, IngestionError> {
    ingest(&state.pool, sid).await
}
