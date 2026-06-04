// End-to-end sanity check for the feed ingestion pipeline:
//   1. 200 path  — parse + insert + cache headers + last_fetched
//   2. 304 path  — no new items, last_fetched still bumped, NotModified outcome
//   3. dedup     — second 200 with identical body inserts 0 / skips N
//
// Uses httpmock so tests stay hermetic. Source URL is the mock server's
// 127.0.0.1:xxxxx URL; reqwest in net::fetch hits it directly.

use fluent_reader_lib::models::{IngestionOutcome, NewSource};
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

    let outcome = feeds::ingest(&pool, sid).await.expect("ingest 200");
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

    feeds::ingest(&pool, sid).await.expect("first ingest");
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

    let outcome = feeds::ingest(&pool, sid).await.expect("second ingest");
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

    let first = feeds::ingest(&pool, sid).await.expect("first");
    match first {
        IngestionOutcome::Updated { inserted, .. } => assert_eq!(inserted, 2),
        _ => panic!("expected Updated on first"),
    }

    let second = feeds::ingest(&pool, sid).await.expect("second");
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
