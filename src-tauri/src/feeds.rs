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

/// First `<img src>` in an HTML fragment, resolved to an absolute URL against
/// the article `link`. Returns None when there is no `<img>` or the first one
/// has an empty src. The http(s) gate is applied by the caller, so a relative
/// src that fails to resolve falls through to rejection there.
fn first_img_src(html: &str, link: &str) -> Option<String> {
    let doc = scraper::Html::parse_fragment(html);
    let selector = scraper::Selector::parse("img[src]").expect("static selector parses");
    let src = doc
        .select(&selector)
        .filter_map(|el| el.value().attr("src"))
        .map(str::trim)
        .find(|s| !s.is_empty())?;
    // Resolve relative URLs against the FULL article link (RFC 3986). The
    // original resolved against the link's origin only (item.ts:90), which
    // mishandles path-relative srcs like `images/x.png`; using the full link
    // as base is strictly more correct for well-formed feeds and identical for
    // absolute and root-relative srcs. If the link won't parse, hand back the
    // raw src and let the caller's http(s) gate drop it if it's relative.
    match reqwest::Url::parse(link) {
        Ok(base) => base.join(src).map(|u| u.to_string()).ok(),
        Err(_) => Some(src.to_string()),
    }
}

/// Cover-image URL for an entry, mirroring the original Fluent Reader's
/// `parseContent` cascade (src/scripts/models/item.ts:73-102):
///   1. media:thumbnail
///   2. (original also checks the channel `<image>`; feed-rs doesn't surface it
///      per-entry, so it's intentionally omitted here)
///   3. media:content whose MIME type is `image/*`. The original filters on the
///      `media:medium="image"` attribute, which feed-rs does not model; the MIME
///      check is the closest feed-rs-native proxy — an intentional adaptation,
///      not an exact port.
///   4. the first `<img src>` in the content HTML.
/// Any candidate that isn't an absolute http(s) URL after resolution is rejected
/// (matches the original's final guard), filtering data:, javascript:, and
/// protocol-relative URLs.
fn extract_thumb(
    media: &[feed_rs::model::MediaObject],
    content: Option<&str>,
    link: &str,
) -> Option<String> {
    let candidate = media
        .iter()
        .flat_map(|m| &m.thumbnails)
        .next()
        .map(|t| t.image.uri.clone())
        .or_else(|| {
            media
                .iter()
                .flat_map(|m| &m.content)
                .find(|c| {
                    c.content_type
                        .as_ref()
                        .map_or(false, |ct| ct.to_string().to_ascii_lowercase().starts_with("image/"))
                })
                .and_then(|c| c.url.as_ref())
                .map(|u| u.to_string())
        })
        .or_else(|| content.and_then(|html| first_img_src(html, link)));

    // Final guard, matching the original (item.ts:96-100): keep only absolute
    // http(s) URLs. Case-sensitive, like the original `startsWith("https://")`.
    candidate.filter(|s| s.starts_with("http://") || s.starts_with("https://"))
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
    let thumb = extract_thumb(&entry.media, content.as_deref(), &link);
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

#[cfg(test)]
mod tests {
    use super::*;
    use feed_rs::model::{Image, MediaContent, MediaObject, MediaThumbnail};

    fn image(uri: &str) -> Image {
        Image {
            uri: uri.to_string(),
            title: None,
            link: None,
            width: None,
            height: None,
            description: None,
        }
    }

    // MediaObject derives Default; MediaContent/MediaThumbnail/Image do not, so
    // build those with full struct literals. MediaTypeBuf and Url are produced
    // via `.parse()` with inference, avoiding extra imports of transitive crates.
    fn thumb_media(uri: &str) -> MediaObject {
        MediaObject {
            thumbnails: vec![MediaThumbnail {
                image: image(uri),
                time: None,
            }],
            ..Default::default()
        }
    }

    fn content_media(url: &str, content_type: Option<&str>) -> MediaObject {
        MediaObject {
            content: vec![MediaContent {
                url: Some(url.parse().unwrap()),
                content_type: content_type.map(|c| c.parse().unwrap()),
                height: None,
                width: None,
                duration: None,
                size: None,
                rating: None,
            }],
            ..Default::default()
        }
    }

    const LINK: &str = "https://site.com/blog/post";

    #[test]
    fn thumbnail_wins_over_content_img() {
        let media = vec![thumb_media("https://cdn.example.com/thumb.jpg")];
        let html = Some("<p><img src=\"https://cdn.example.com/inline.jpg\"></p>");
        assert_eq!(
            extract_thumb(&media, html, LINK),
            Some("https://cdn.example.com/thumb.jpg".to_string())
        );
    }

    #[test]
    fn media_content_image_used_when_no_thumbnail() {
        let media = vec![content_media("https://cdn.example.com/a.png", Some("image/png"))];
        assert_eq!(
            extract_thumb(&media, None, LINK),
            Some("https://cdn.example.com/a.png".to_string())
        );
    }

    #[test]
    fn media_content_non_image_falls_through_to_img() {
        let media = vec![content_media("https://cdn.example.com/clip.mp4", Some("video/mp4"))];
        let html = Some("<p><img src=\"https://cdn.example.com/b.jpg\"></p>");
        assert_eq!(
            extract_thumb(&media, html, LINK),
            Some("https://cdn.example.com/b.jpg".to_string())
        );
    }

    #[test]
    fn media_content_beats_img() {
        let media = vec![content_media("https://cdn.example.com/m.png", Some("image/png"))];
        let html = Some("<img src=\"https://cdn.example.com/inline.jpg\">");
        assert_eq!(
            extract_thumb(&media, html, LINK),
            Some("https://cdn.example.com/m.png".to_string())
        );
    }

    #[test]
    fn img_absolute_src() {
        let html = Some("<p>hi</p><img src=\"https://cdn.example.com/a.jpg\">");
        assert_eq!(
            extract_thumb(&[], html, LINK),
            Some("https://cdn.example.com/a.jpg".to_string())
        );
    }

    #[test]
    fn img_root_relative_src_resolves_against_origin() {
        let html = Some("<img src=\"/img/a.png\">");
        assert_eq!(
            extract_thumb(&[], html, LINK),
            Some("https://site.com/img/a.png".to_string())
        );
    }

    #[test]
    fn img_path_relative_src_resolves_against_full_link() {
        // Diverges from the original (which used origin only): a path-relative
        // src resolves against the full article path. `/blog/post` has no
        // trailing slash, so RFC 3986 drops the last segment → /blog/.
        let html = Some("<img src=\"images/a.png\">");
        assert_eq!(
            extract_thumb(&[], html, "https://site.com/blog/post/"),
            Some("https://site.com/blog/post/images/a.png".to_string())
        );
    }

    #[test]
    fn no_img_returns_none() {
        let html = Some("<p>no images here</p>");
        assert_eq!(extract_thumb(&[], html, LINK), None);
    }

    #[test]
    fn data_uri_src_rejected() {
        let html = Some("<img src=\"data:image/png;base64,AAAA\">");
        assert_eq!(extract_thumb(&[], html, LINK), None);
    }

    #[test]
    fn javascript_uri_src_rejected() {
        let html = Some("<img src=\"javascript:alert(1)\">");
        assert_eq!(extract_thumb(&[], html, LINK), None);
    }

    #[test]
    fn first_img_among_several() {
        let html = Some(
            "<img src=\"https://cdn.example.com/first.jpg\">\
             <img src=\"https://cdn.example.com/second.jpg\">",
        );
        assert_eq!(
            extract_thumb(&[], html, LINK),
            Some("https://cdn.example.com/first.jpg".to_string())
        );
    }

    #[test]
    fn empty_src_skipped_for_next_valid() {
        let html = Some(
            "<img src=\"\">\
             <img src=\"https://cdn.example.com/real.jpg\">",
        );
        assert_eq!(
            extract_thumb(&[], html, LINK),
            Some("https://cdn.example.com/real.jpg".to_string())
        );
    }
}
