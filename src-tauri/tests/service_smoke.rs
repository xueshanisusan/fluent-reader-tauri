use fluent_reader_lib::db;
use fluent_reader_lib::models::{NewItem, NewRule, NewSource};
use fluent_reader_lib::repo;
use fluent_reader_lib::service::{ingest_items, reconcile_sources, GroupImport, SyncResult};
use fluent_reader_lib::service::fever::{FeedGroup, FeverItem, RemoteFeed, RemoteGroup};

async fn make_local(pool: &sqlx::SqlitePool, url: &str, name: &str) -> i64 {
    repo::sources::create(
        pool,
        NewSource {
            url: url.into(),
            name: name.into(),
            icon_url: None,
            group_id: None,
            open_target: None,
            fetch_frequency: None,
            text_dir: None,
        },
    )
    .await
    .unwrap()
    .sid
}

async fn set_ref(pool: &sqlx::SqlitePool, sid: i64, service_ref: &str) {
    let mut tx = pool.begin().await.unwrap();
    repo::sources::set_service_ref_in_tx(&mut tx, sid, service_ref)
        .await
        .unwrap();
    tx.commit().await.unwrap();
}

fn feed(id: i64, url: &str, title: &str) -> RemoteFeed {
    RemoteFeed {
        id,
        url: url.into(),
        title: title.into(),
    }
}

#[tokio::test]
async fn reconcile_creates_new_remote_sources() {
    let pool = db::open_memory().await.unwrap();
    let remote = vec![
        feed(1, "https://a.example/feed", "A"),
        feed(2, "https://b.example/feed", "B"),
    ];

    let SyncResult {
        added,
        adopted,
        removed,
        grouped,
        ..
    } = reconcile_sources(&pool, &remote, None).await.unwrap();
    assert_eq!((added, adopted, removed, grouped), (2, 0, 0, 0));

    let sources = repo::sources::list(&pool).await.unwrap();
    assert_eq!(sources.len(), 2);
    let a = sources.iter().find(|s| s.url == "https://a.example/feed").unwrap();
    assert_eq!(a.service_ref.as_deref(), Some("1"));
}

#[tokio::test]
async fn reconcile_adopts_url_matching_local_source_and_wipes_items() {
    let pool = db::open_memory().await.unwrap();
    let sid = make_local(&pool, "https://a.example/feed", "A (local)").await;
    repo::items::insert_many(
        &pool,
        vec![NewItem {
            source_id: sid,
            title: "old local item".into(),
            link: "https://a.example/1".into(),
            date_ms: 100,
            ..Default::default()
        }],
    )
    .await
    .unwrap();
    assert_eq!(
        repo::items::list(&pool, Some(sid), None, None, false, 100, 0)
            .await
            .unwrap()
            .len(),
        1
    );

    let remote = vec![feed(42, "https://a.example/feed", "A (remote)")];
    let res = reconcile_sources(&pool, &remote, None).await.unwrap();
    assert_eq!((res.added, res.adopted, res.removed), (0, 1, 0));

    // Same source row, now carrying the service_ref, with its items wiped.
    let sources = repo::sources::list(&pool).await.unwrap();
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0].sid, sid, "adopted in place, not recreated");
    assert_eq!(sources[0].service_ref.as_deref(), Some("42"));
    assert_eq!(
        repo::items::list(&pool, Some(sid), None, None, false, 100, 0)
            .await
            .unwrap()
            .len(),
        0,
        "adoption wipes the source's local items"
    );
}

#[tokio::test]
async fn reconcile_reuses_already_mapped_source_untouched() {
    let pool = db::open_memory().await.unwrap();
    let sid = make_local(&pool, "https://a.example/feed", "A").await;
    set_ref(&pool, sid, "7").await;
    repo::items::insert_many(
        &pool,
        vec![NewItem {
            source_id: sid,
            title: "kept".into(),
            link: "https://a.example/1".into(),
            date_ms: 100,
            ..Default::default()
        }],
    )
    .await
    .unwrap();

    let remote = vec![feed(7, "https://a.example/feed", "A")];
    let res = reconcile_sources(&pool, &remote, None).await.unwrap();
    assert_eq!((res.added, res.adopted, res.removed), (0, 0, 0));
    assert_eq!(
        repo::items::list(&pool, Some(sid), None, None, false, 100, 0)
            .await
            .unwrap()
            .len(),
        1,
        "reused source keeps its items"
    );
}

#[tokio::test]
async fn reconcile_deletes_remote_source_absent_from_server() {
    let pool = db::open_memory().await.unwrap();
    let keep = make_local(&pool, "https://keep.example/feed", "Keep").await;
    set_ref(&pool, keep, "1").await;
    let gone = make_local(&pool, "https://gone.example/feed", "Gone").await;
    set_ref(&pool, gone, "2").await;
    let local_only = make_local(&pool, "https://local.example/feed", "Local").await;

    // Server only lists ref 1 now.
    let remote = vec![feed(1, "https://keep.example/feed", "Keep")];
    let res = reconcile_sources(&pool, &remote, None).await.unwrap();
    assert_eq!((res.added, res.adopted, res.removed), (0, 0, 1));

    let sources = repo::sources::list(&pool).await.unwrap();
    let urls: Vec<&str> = sources.iter().map(|s| s.url.as_str()).collect();
    assert!(urls.contains(&"https://keep.example/feed"));
    assert!(
        urls.contains(&"https://local.example/feed"),
        "plain-local (no service_ref) source is never touched"
    );
    assert!(
        !urls.contains(&"https://gone.example/feed"),
        "remote source dropped server-side is deleted"
    );
    let _ = local_only;
}

#[tokio::test]
async fn reconcile_adopts_across_url_spelling_differences() {
    let pool = db::open_memory().await.unwrap();
    // OPML-imported with https + trailing slash.
    let sid = make_local(&pool, "https://a.example/feed/", "A (opml)").await;

    // Fever reports the same feed as http, no trailing slash.
    let remote = vec![feed(5, "http://a.example/feed", "A (fever)")];
    let res = reconcile_sources(&pool, &remote, None).await.unwrap();
    assert_eq!(
        (res.added, res.adopted),
        (0, 1),
        "URL-spelling differences still adopt, not duplicate"
    );

    let sources = repo::sources::list(&pool).await.unwrap();
    assert_eq!(sources.len(), 1, "no duplicate source created");
    assert_eq!(sources[0].sid, sid);
    assert_eq!(sources[0].service_ref.as_deref(), Some("5"));
}

#[tokio::test]
async fn reconcile_imports_groups_and_assigns_sources() {
    let pool = db::open_memory().await.unwrap();
    let remote = vec![
        feed(1, "https://a.example/feed", "A"),
        feed(2, "https://b.example/feed", "B"),
        feed(3, "https://c.example/feed", "C"),
    ];
    let gi = GroupImport {
        groups: vec![RemoteGroup {
            id: 10,
            title: "Tech".into(),
        }],
        feed_groups: vec![FeedGroup {
            group_id: 10,
            feed_ids: vec![1, 2],
        }],
    };

    let res = reconcile_sources(&pool, &remote, Some(&gi)).await.unwrap();
    assert_eq!((res.added, res.grouped), (3, 2));

    let groups = repo::groups::list(&pool).await.unwrap();
    let tech = groups.iter().find(|g| g.name == "Tech").expect("Tech group created");
    let sources = repo::sources::list(&pool).await.unwrap();
    let by_url = |u: &str| sources.iter().find(|s| s.url == u).unwrap();
    assert_eq!(by_url("https://a.example/feed").group_id, Some(tech.gid));
    assert_eq!(by_url("https://b.example/feed").group_id, Some(tech.gid));
    assert_eq!(
        by_url("https://c.example/feed").group_id,
        None,
        "ungrouped feed stays ungrouped"
    );
}

fn fitem(id: i64, feed_id: i64, url: &str, title: &str, html: &str) -> FeverItem {
    FeverItem {
        id,
        feed_id,
        title: title.into(),
        url: url.into(),
        html: html.into(),
        author: String::new(),
        created_on_time: 1_700_000_000,
        is_read: false,
        is_saved: false,
    }
}

#[tokio::test]
async fn ingest_maps_items_to_source_by_service_ref() {
    let pool = db::open_memory().await.unwrap();
    let sid = make_local(&pool, "https://a.example/feed", "A").await;
    set_ref(&pool, sid, "10").await;

    let mut it = fitem(100, 10, "https://a.example/1", "Hi", "<p>Hello <b>world</b></p>");
    it.is_read = true;
    it.is_saved = true;
    let fetched = ingest_items(&pool, &[it]).await.unwrap();
    assert_eq!(fetched, 1);

    let items = repo::items::list(&pool, Some(sid), None, None, false, 100, 0)
        .await
        .unwrap();
    assert_eq!(items.len(), 1);
    let item = &items[0];
    assert_eq!(item.source_id, sid);
    assert_eq!(item.service_ref.as_deref(), Some("100"));
    assert_eq!(item.link, "https://a.example/1");
    assert_eq!(item.date_ms, 1_700_000_000 * 1000);
    assert!(item.has_read, "is_read maps to has_read");
    assert!(item.starred, "is_saved maps to starred");
    assert_eq!(item.snippet, "Hello world", "snippet is stripped HTML text");
}

#[tokio::test]
async fn ingest_skips_items_for_unknown_feed() {
    let pool = db::open_memory().await.unwrap();
    let sid = make_local(&pool, "https://a.example/feed", "A").await;
    set_ref(&pool, sid, "10").await;

    // feed_id 99 has no matching local source → dropped.
    let fetched = ingest_items(&pool, &[fitem(1, 99, "https://x/1", "X", "x")])
        .await
        .unwrap();
    assert_eq!(fetched, 0);
    assert_eq!(
        repo::items::list(&pool, None, None, None, false, 100, 0)
            .await
            .unwrap()
            .len(),
        0
    );
}

#[tokio::test]
async fn ingest_dedups_on_link() {
    let pool = db::open_memory().await.unwrap();
    let sid = make_local(&pool, "https://a.example/feed", "A").await;
    set_ref(&pool, sid, "10").await;

    let it = fitem(100, 10, "https://a.example/1", "Hi", "body");
    assert_eq!(ingest_items(&pool, &[it.clone()]).await.unwrap(), 1);
    // Same (source_id, link) on a second pull → dedup-skipped.
    assert_eq!(ingest_items(&pool, &[it]).await.unwrap(), 0);
    assert_eq!(
        repo::items::list(&pool, Some(sid), None, None, false, 100, 0)
            .await
            .unwrap()
            .len(),
        1
    );
}

#[tokio::test]
async fn ingest_applies_source_rules() {
    let pool = db::open_memory().await.unwrap();
    let sid = make_local(&pool, "https://a.example/feed", "A").await;
    set_ref(&pool, sid, "10").await;
    // Rule: title contains "urgent" → mark read.
    repo::rules::create(
        &pool,
        NewRule {
            source_id: sid,
            position: 0,
            filter_type_mask: 1, // MASK_TITLE
            filter_search: "urgent".into(),
            filter_match: true,
            action_read: Some(1),
            action_star: None,
            action_hide: None,
            action_notify: None,
        },
    )
    .await
    .unwrap();

    let items = vec![
        fitem(100, 10, "https://a.example/1", "Urgent notice", "x"),
        fitem(101, 10, "https://a.example/2", "Just chatting", "x"),
    ];
    assert_eq!(ingest_items(&pool, &items).await.unwrap(), 2);

    let urgent = repo::items::list(&pool, Some(sid), None, None, false, 100, 0)
        .await
        .unwrap()
        .into_iter()
        .find(|i| i.title == "Urgent notice")
        .unwrap();
    assert!(urgent.has_read, "rule marked the matching item read");
    let chat = repo::items::list(&pool, Some(sid), None, None, false, 100, 0)
        .await
        .unwrap()
        .into_iter()
        .find(|i| i.title == "Just chatting")
        .unwrap();
    assert!(!chat.has_read, "non-matching item untouched");
}
