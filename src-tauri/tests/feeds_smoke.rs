// End-to-end sanity check for the feed ingestion pipeline:
//   1. 200 path  — parse + insert + cache headers + last_fetched
//   2. 304 path  — no new items, last_fetched still bumped, NotModified outcome
//   3. dedup     — second 200 with identical body inserts 0 / skips N
//
// Uses httpmock so tests stay hermetic. Source URL is the mock server's
// 127.0.0.1:xxxxx URL; reqwest in net::fetch hits it directly.

use fluent_reader_lib::models::{DiscoveryError, IngestionOutcome, NewSource};
use fluent_reader_lib::{db, feeds, repo};
use httpmock::prelude::*;

const RSS_BODY: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Feed</title>
    <link>http://example.com</link>
    <description>Test</description>
    <item>
      <title>First post</title>
      <link>http://example.com/post-1</link>
      <pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate>
      <description>Hello</description>
    </item>
    <item>
      <title>Second post</title>
      <link>http://example.com/post-2</link>
      <pubDate>Tue, 02 Jan 2024 00:00:00 GMT</pubDate>
      <description>World</description>
    </item>
  </channel>
</rss>"#;

async fn make_source(pool: &sqlx::SqlitePool, url: String) -> i64 {
    repo::sources::create(
        pool,
        NewSource {
            url,
            name: "Test".to_string(),
            icon_url: None,
            group_id: None,
            open_target: None,
            fetch_frequency: None,
            text_dir: None,
        },
    )
    .await
    .expect("create source")
    .sid
}

#[tokio::test]
async fn ingest_200_inserts_and_persists_cache_headers() {
    let server = MockServer::start_async().await;
    let _mock = server
        .mock_async(|when, then| {
            when.method(GET).path("/feed");
            then.status(200)
                .header("content-type", "application/rss+xml")
                .header("etag", "\"abc\"")
                .header("last-modified", "Mon, 01 Jan 2024 00:00:00 GMT")
                .body(RSS_BODY);
        })
        .await;

    let pool = db::open_memory().await.expect("open db");
    let sid = make_source(&pool, server.url("/feed")).await;

    let (outcome, _, _) = feeds::ingest_core(&pool, sid).await.expect("ingest 200");
    match outcome {
        IngestionOutcome::Updated { inserted, skipped, .. } => {
            assert_eq!(inserted, 2, "two new items inserted");
            assert_eq!(skipped, 0);
        }
        IngestionOutcome::NotModified { .. } => panic!("expected Updated, got NotModified"),
    }

    let items = repo::items::list(&pool, Some(sid), None, None, 10, 0)
        .await
        .expect("list items");
    assert_eq!(items.len(), 2);

    let src_after = repo::sources::get(&pool, sid).await.expect("get source");
    assert_eq!(src_after.etag.as_deref(), Some("\"abc\""));
    assert_eq!(
        src_after.last_modified.as_deref(),
        Some("Mon, 01 Jan 2024 00:00:00 GMT")
    );
    assert!(src_after.last_fetched_ms > 0, "last_fetched_ms should be set");
}

#[tokio::test]
async fn ingest_304_skips_insert_but_updates_last_fetched() {
    let server = MockServer::start_async().await;
    let m200 = server
        .mock_async(|when, then| {
            when.method(GET).path("/feed");
            then.status(200)
                .header("content-type", "application/rss+xml")
                .header("etag", "\"v1\"")
                .body(RSS_BODY);
        })
        .await;

    let pool = db::open_memory().await.expect("open db");
    let sid = make_source(&pool, server.url("/feed")).await;

    feeds::ingest_core(&pool, sid).await.expect("first ingest");
    let after_first = repo::sources::get(&pool, sid).await.expect("get");
    let first_fetched = after_first.last_fetched_ms;
    m200.delete_async().await;

    let _m304 = server
        .mock_async(|when, then| {
            when.method(GET)
                .path("/feed")
                .header("If-None-Match", "\"v1\"");
            then.status(304);
        })
        .await;

    // Small sleep so last_fetched_ms actually advances (ms granularity).
    tokio::time::sleep(std::time::Duration::from_millis(5)).await;

    let (outcome, _, _) = feeds::ingest_core(&pool, sid).await.expect("second ingest");
    match outcome {
        IngestionOutcome::NotModified { .. } => {}
        IngestionOutcome::Updated { .. } => panic!("expected NotModified"),
    }

    let items = repo::items::list(&pool, Some(sid), None, None, 10, 0)
        .await
        .expect("list items");
    assert_eq!(items.len(), 2, "no new items on 304");

    let after_second = repo::sources::get(&pool, sid).await.expect("get");
    assert!(
        after_second.last_fetched_ms > first_fetched,
        "last_fetched_ms should advance on 304"
    );
    assert_eq!(
        after_second.etag.as_deref(),
        Some("\"v1\""),
        "etag preserved on 304"
    );
}

#[tokio::test]
async fn discover_returns_input_when_body_is_feed() {
    let server = MockServer::start_async().await;
    let _m = server
        .mock_async(|when, then| {
            when.method(GET).path("/feed.xml");
            then.status(200)
                .header("content-type", "application/rss+xml")
                .body(RSS_BODY);
        })
        .await;

    let url = server.url("/feed.xml");
    let results = feeds::discover(&url).await.expect("discover feed url");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].url, url);
    assert_eq!(results[0].title.as_deref(), Some("Test Feed"));
}

#[tokio::test]
async fn discover_extracts_single_feed_link_from_html() {
    let server = MockServer::start_async().await;
    let html = r#"<!doctype html>
<html><head>
<title>My Blog</title>
<link rel="alternate" type="application/rss+xml" title="My Blog Feed" href="/feed.xml">
</head><body>hi</body></html>"#;
    let _m = server
        .mock_async(|when, then| {
            when.method(GET).path("/");
            then.status(200).header("content-type", "text/html").body(html);
        })
        .await;

    let results = feeds::discover(&server.url("/")).await.expect("discover html");
    assert_eq!(results.len(), 1);
    assert_eq!(results[0].url, server.url("/feed.xml"), "relative href resolved");
    assert_eq!(results[0].title.as_deref(), Some("My Blog Feed"));
}

#[tokio::test]
async fn discover_extracts_multiple_feeds_from_html() {
    let server = MockServer::start_async().await;
    let html = r#"<!doctype html>
<html><head>
<link rel="alternate" type="application/rss+xml" title="Posts" href="https://other.example/posts.rss">
<link rel="alternate" type="application/atom+xml" title="Comments" href="/comments.atom">
<link rel="alternate" type="text/html" href="/de/" title="not a feed">
</head></html>"#;
    let _m = server
        .mock_async(|when, then| {
            when.method(GET).path("/");
            then.status(200).header("content-type", "text/html").body(html);
        })
        .await;

    let results = feeds::discover(&server.url("/")).await.expect("discover html");
    assert_eq!(results.len(), 2, "ignore non-feed alternate types");
    assert!(results.iter().any(|r| r.url == "https://other.example/posts.rss"));
    assert!(results.iter().any(|r| r.url == server.url("/comments.atom")));
}

#[tokio::test]
async fn discover_returns_not_found_when_no_feed_link() {
    let server = MockServer::start_async().await;
    let _m = server
        .mock_async(|when, then| {
            when.method(GET).path("/");
            then.status(200)
                .header("content-type", "text/html")
                .body("<html><head><title>Plain</title></head><body>no feeds here</body></html>");
        })
        .await;

    let err = feeds::discover(&server.url("/"))
        .await
        .expect_err("should not find feed");
    matches!(err, DiscoveryError::NotFound { .. });
}

#[tokio::test]
async fn ingest_dedup_on_identical_200_body() {
    // No etag/last-modified in response → second call cannot 304; server returns
    // identical body. Dedup must skip all rows via ON CONFLICT(source_id, link).
    let server = MockServer::start_async().await;
    let _mock = server
        .mock_async(|when, then| {
            when.method(GET).path("/feed");
            then.status(200)
                .header("content-type", "application/rss+xml")
                .body(RSS_BODY);
        })
        .await;

    let pool = db::open_memory().await.expect("open db");
    let sid = make_source(&pool, server.url("/feed")).await;

    let (first, _, _) = feeds::ingest_core(&pool, sid).await.expect("first");
    match first {
        IngestionOutcome::Updated { inserted, .. } => assert_eq!(inserted, 2),
        _ => panic!("expected Updated on first"),
    }

    let (second, _, _) = feeds::ingest_core(&pool, sid).await.expect("second");
    match second {
        IngestionOutcome::Updated { inserted, skipped, .. } => {
            assert_eq!(inserted, 0, "no inserts on identical body");
            assert_eq!(skipped, 2, "both items skipped via ON CONFLICT");
        }
        IngestionOutcome::NotModified { .. } => panic!("expected Updated/0 inserted"),
    }

    let items = repo::items::list(&pool, Some(sid), None, None, 10, 0)
        .await
        .expect("list items");
    assert_eq!(items.len(), 2, "still just 2 items total");
}

#[tokio::test]
async fn backfill_fills_missing_thumbs_from_content() {
    use fluent_reader_lib::models::NewItem;

    let pool = db::open_memory().await.expect("open db");
    let sid = make_source(&pool, "http://example.com/feed".to_string()).await;

    let items = vec![
        // <img> in content, no thumb → should be filled.
        NewItem {
            source_id: sid,
            title: "with image".into(),
            link: "https://site.com/post-1".into(),
            date_ms: 1,
            content: Some("<p>hi</p><img src=\"https://cdn.example.com/a.jpg\">".into()),
            ..Default::default()
        },
        // No image in content → stays NULL.
        NewItem {
            source_id: sid,
            title: "no image".into(),
            link: "https://site.com/post-2".into(),
            date_ms: 2,
            content: Some("<p>just text</p>".into()),
            ..Default::default()
        },
        // Already thumbed → excluded from scan entirely, value untouched.
        NewItem {
            source_id: sid,
            title: "already thumbed".into(),
            link: "https://site.com/post-3".into(),
            date_ms: 3,
            thumb: Some("https://existing/x.jpg".into()),
            content: Some("<img src=\"https://cdn.example.com/b.jpg\">".into()),
            ..Default::default()
        },
    ];
    repo::items::insert_many(&pool, items).await.expect("insert");

    let summary = feeds::backfill_thumbs_core(&pool).await.expect("backfill");
    assert_eq!(summary.scanned, 2, "two thumbless rows scanned (thumbed row excluded)");
    assert_eq!(summary.updated, 1, "one row gained a thumb");

    let all = repo::items::list(&pool, Some(sid), None, None, 10, 0)
        .await
        .expect("list");
    let by_title = |t: &str| all.iter().find(|i| i.title == t).expect("item present");
    assert_eq!(
        by_title("with image").thumb.as_deref(),
        Some("https://cdn.example.com/a.jpg")
    );
    assert_eq!(by_title("no image").thumb, None);
    assert_eq!(
        by_title("already thumbed").thumb.as_deref(),
        Some("https://existing/x.jpg"),
        "pre-existing thumb is not overwritten"
    );

    // Idempotent: second run finds only the still-thumbless no-image row and
    // changes nothing.
    let again = feeds::backfill_thumbs_core(&pool).await.expect("backfill 2");
    assert_eq!(again.scanned, 1, "only the no-image row remains thumbless");
    assert_eq!(again.updated, 0, "nothing new to update");
}
