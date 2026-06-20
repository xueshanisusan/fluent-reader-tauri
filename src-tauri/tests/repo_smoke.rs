use fluent_reader_lib::db;
use fluent_reader_lib::models::{NewItem, NewRule, NewSource, RulePatch};
use fluent_reader_lib::repo;

#[tokio::test]
async fn repo_crud_roundtrip() {
    let pool = db::open_memory().await.expect("open in-memory db");

    // -- groups --
    assert!(repo::groups::list(&pool).await.unwrap().is_empty());

    let g_tech = repo::groups::create(&pool, "Tech").await.unwrap();
    let g_news = repo::groups::create(&pool, "News").await.unwrap();
    assert_eq!(g_tech.name, "Tech");
    assert_eq!(g_tech.expanded, true, "expanded defaults true");
    assert_eq!(g_tech.position, 0);
    assert_eq!(g_news.position, 1, "second group gets next position");

    repo::groups::rename(&pool, g_tech.gid, "Engineering").await.unwrap();
    repo::groups::set_expanded(&pool, g_tech.gid, false).await.unwrap();
    repo::groups::set_position(&pool, g_tech.gid, 5).await.unwrap();

    let groups = repo::groups::list(&pool).await.unwrap();
    let renamed = groups.iter().find(|g| g.gid == g_tech.gid).unwrap();
    assert_eq!(renamed.name, "Engineering");
    assert_eq!(renamed.expanded, false);
    assert_eq!(renamed.position, 5);

    // -- sources --
    let src_grouped = repo::sources::create(
        &pool,
        NewSource {
            url: "https://hnrss.org/frontpage".into(),
            name: "Hacker News".into(),
            icon_url: None,
            group_id: Some(g_tech.gid),
            open_target: None,
            fetch_frequency: None,
            text_dir: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(src_grouped.group_id, Some(g_tech.gid));
    assert_eq!(src_grouped.position, 0);
    assert_eq!(src_grouped.icon_url, None);
    assert_eq!(src_grouped.hidden, false);

    let src_loose = repo::sources::create(
        &pool,
        NewSource {
            url: "https://example.com/feed.xml".into(),
            name: "Example".into(),
            icon_url: None,
            group_id: None,
            open_target: Some(2),
            fetch_frequency: Some(60),
            text_dir: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(src_loose.group_id, None);
    assert_eq!(src_loose.open_target, 2);
    assert_eq!(src_loose.fetch_frequency, 60);

    repo::sources::rename(&pool, src_grouped.sid, "HN").await.unwrap();
    repo::sources::set_icon_url(
        &pool,
        src_grouped.sid,
        Some("https://news.ycombinator.com/favicon.ico".into()),
    )
    .await
    .unwrap();
    repo::sources::set_group(&pool, src_grouped.sid, None).await.unwrap();
    repo::sources::set_hidden(&pool, src_grouped.sid, true).await.unwrap();
    repo::sources::set_last_fetched(&pool, src_grouped.sid, 1714896000000).await.unwrap();
    repo::sources::set_fetch_frequency(&pool, src_grouped.sid, 30).await.unwrap();

    let sources = repo::sources::list(&pool).await.unwrap();
    let hn = sources.iter().find(|s| s.sid == src_grouped.sid).unwrap();
    assert_eq!(hn.name, "HN");
    assert_eq!(hn.icon_url.as_deref(), Some("https://news.ycombinator.com/favicon.ico"));
    assert_eq!(hn.group_id, None, "set_group(None) should clear group_id");
    assert_eq!(hn.hidden, true);
    assert_eq!(hn.last_fetched_ms, 1714896000000);
    assert_eq!(hn.fetch_frequency, 30);

    // -- rules --
    assert!(repo::rules::list_for_source(&pool, src_loose.sid).await.unwrap().is_empty());

    let rule = repo::rules::create(
        &pool,
        NewRule {
            source_id: src_loose.sid,
            position: 0,
            filter_type_mask: 0,
            filter_search: "rust".into(),
            filter_match: true,
            action_read: Some(1),
            action_star: None,
            action_hide: None,
            action_notify: None,
        },
    )
    .await
    .unwrap();
    assert_eq!(rule.filter_search, "rust");
    assert_eq!(rule.action_read, Some(1));
    assert_eq!(rule.action_star, None);

    repo::rules::update(
        &pool,
        rule.rid,
        RulePatch {
            position: 1,
            filter_type_mask: 2,
            filter_search: "go".into(),
            filter_match: false,
            action_read: None,
            action_star: Some(1),
            action_hide: None,
            action_notify: None,
        },
    )
    .await
    .unwrap();

    let rules = repo::rules::list_for_source(&pool, src_loose.sid).await.unwrap();
    assert_eq!(rules.len(), 1);
    assert_eq!(rules[0].filter_search, "go");
    assert_eq!(rules[0].filter_match, false);
    assert_eq!(rules[0].action_read, None);
    assert_eq!(rules[0].action_star, Some(1));
    assert_eq!(rules[0].position, 1);

    repo::rules::delete(&pool, rule.rid).await.unwrap();
    assert!(repo::rules::list_for_source(&pool, src_loose.sid).await.unwrap().is_empty());

    // -- items --
    let now_ms: i64 = 1714896000000;
    let new_items: Vec<NewItem> = (0..5_i64)
        .map(|i| NewItem {
            source_id: src_loose.sid,
            title: format!("Item {}", i),
            link: format!("https://example.com/{}", i),
            date_ms: now_ms + i,
            thumb: None,
            content: Some(format!("<p>body {}</p>", i)),
            snippet: Some(format!("body {}", i)),
            creator: if i % 2 == 0 { Some("alice".into()) } else { None },
            guid: None,
            ..Default::default()
        })
        .collect();
    let inserted = repo::items::insert_many(&pool, new_items).await.unwrap();
    assert_eq!(inserted, 5);

    let all = repo::items::list(&pool, Some(src_loose.sid), None, None, 100, 0).await.unwrap();
    assert_eq!(all.len(), 5);
    assert_eq!(all[0].title, "Item 4", "DESC ordering by date_ms");
    assert_eq!(all[4].title, "Item 0");
    assert_eq!(all[0].content, "<p>body 4</p>");
    assert_eq!(all[0].snippet, "body 4");
    assert!(all[0].fetched_date_ms > 0, "fetched_date_ms is server-set");

    repo::items::mark_read(&pool, all[0].iid, true).await.unwrap();
    repo::items::mark_read(&pool, all[1].iid, true).await.unwrap();
    repo::items::set_starred(&pool, all[2].iid, true).await.unwrap();

    let unread = repo::items::list(&pool, Some(src_loose.sid), Some(false), None, 100, 0)
        .await
        .unwrap();
    assert_eq!(unread.len(), 3);

    let starred = repo::items::list(&pool, None, None, Some(true), 100, 0).await.unwrap();
    assert_eq!(starred.len(), 1);
    assert_eq!(starred[0].title, "Item 2");

    let counts = repo::items::unread_counts(&pool).await.unwrap();
    assert_eq!(counts.len(), 1);
    assert_eq!(counts[0].source_id, src_loose.sid);
    assert_eq!(counts[0].count, 3);

    // pagination
    let page = repo::items::list(&pool, Some(src_loose.sid), None, None, 2, 1).await.unwrap();
    assert_eq!(page.len(), 2);
    assert_eq!(page[0].title, "Item 3");
    assert_eq!(page[1].title, "Item 2");

    // empty-input guard
    assert_eq!(repo::items::insert_many(&pool, vec![]).await.unwrap(), 0);

    // -- delete cleanup --
    repo::sources::delete(&pool, src_loose.sid).await.unwrap();
    let counts_after = repo::items::unread_counts(&pool).await.unwrap();
    assert!(counts_after.is_empty(), "items cascade-deleted with source");

    repo::groups::delete(&pool, g_news.gid).await.unwrap();
    let groups_after = repo::groups::list(&pool).await.unwrap();
    assert_eq!(groups_after.len(), 1);
    assert_eq!(groups_after[0].gid, g_tech.gid);
}

#[tokio::test]
async fn insert_dedup_skips_on_guid_match_even_when_link_changes() {
    // Stronger dedup: a feed that re-issues the same <guid> with a mutated link
    // (e.g. URL params, redirect normalization) should still be skipped.
    let pool = db::open_memory().await.expect("open db");
    let src = repo::sources::create(
        &pool,
        NewSource {
            url: "https://blog.example.com/feed".into(),
            name: "Blog".into(),
            icon_url: None,
            group_id: None,
            open_target: None,
            fetch_frequency: None,
            text_dir: None,
        },
    )
    .await
    .unwrap();

    let first = NewItem {
        source_id: src.sid,
        title: "Post A".into(),
        link: "https://blog.example.com/post-a".into(),
        date_ms: 1_700_000_000_000,
        thumb: None,
        content: Some("v1".into()),
        snippet: None,
        creator: None,
        guid: Some("guid-A".into()),
        ..Default::default()
    };
    let second_same_guid_diff_link = NewItem {
        source_id: src.sid,
        title: "Post A".into(),
        // Link mutated with tracking params — looks fresh to (source_id, link).
        link: "https://blog.example.com/post-a?utm_source=rss".into(),
        date_ms: 1_700_000_000_000,
        thumb: None,
        content: Some("v1".into()),
        snippet: None,
        creator: None,
        guid: Some("guid-A".into()),
        ..Default::default()
    };
    let third_no_guid = NewItem {
        source_id: src.sid,
        title: "Post B".into(),
        link: "https://blog.example.com/post-b".into(),
        date_ms: 1_700_000_100_000,
        thumb: None,
        content: None,
        snippet: None,
        creator: None,
        guid: None,
        ..Default::default()
    };

    let mut tx = pool.begin().await.unwrap();
    let (inserted, skipped) =
        repo::items::insert_dedup_in_tx(&mut tx, &[first.clone(), third_no_guid.clone()])
            .await
            .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(inserted, 2);
    assert_eq!(skipped, 0);

    let mut tx = pool.begin().await.unwrap();
    let (inserted2, skipped2) = repo::items::insert_dedup_in_tx(
        &mut tx,
        &[second_same_guid_diff_link.clone(), third_no_guid.clone()],
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(inserted2, 0, "guid match must skip even though link is new");
    assert_eq!(skipped2, 2, "second item also skipped via link index");

    let all = repo::items::list(&pool, Some(src.sid), None, None, 100, 0).await.unwrap();
    assert_eq!(all.len(), 2, "no duplicate rows");
}

async fn make_src(pool: &sqlx::SqlitePool, url: &str, name: &str) -> i64 {
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

fn mk_item(source_id: i64, title: &str, snippet: &str, date_ms: i64) -> NewItem {
    NewItem {
        source_id,
        title: title.into(),
        link: format!("https://example.com/{}-{}", source_id, date_ms),
        date_ms,
        thumb: None,
        content: None,
        snippet: Some(snippet.into()),
        creator: None,
        guid: None,
        ..Default::default()
    }
}

#[tokio::test]
async fn items_search_matches_title_or_snippet() {
    let pool = db::open_memory().await.expect("open in-memory db");
    let sid = make_src(&pool, "https://a.example/feed", "A").await;

    repo::items::insert_many(
        &pool,
        vec![
            mk_item(sid, "Rust 1.85 release notes", "tokio updates", 100),
            mk_item(sid, "Go 1.23 update", "learning Rust patterns", 200),
            mk_item(sid, "Python tips", "nothing relevant", 300),
        ],
    )
    .await
    .unwrap();

    let hits = repo::items::search(&pool, "rust", None, None, None, 50, 0).await.unwrap();
    assert_eq!(hits.len(), 2, "title or snippet match");
    assert_eq!(hits[0].title, "Go 1.23 update", "newer date first (snippet match)");
    assert_eq!(hits[1].title, "Rust 1.85 release notes");

    let none = repo::items::search(&pool, "kotlin", None, None, None, 50, 0).await.unwrap();
    assert!(none.is_empty());
}

#[tokio::test]
async fn items_search_escapes_like_metachars() {
    let pool = db::open_memory().await.expect("open in-memory db");
    let sid = make_src(&pool, "https://b.example/feed", "B").await;

    repo::items::insert_many(
        &pool,
        vec![
            mk_item(sid, "Saved 50% on hosting", "discount", 100),
            mk_item(sid, "Saved an item", "regular post", 200),
        ],
    )
    .await
    .unwrap();

    let pct = repo::items::search(&pool, "50%", None, None, None, 50, 0).await.unwrap();
    assert_eq!(pct.len(), 1, "literal % must not act as wildcard");
    assert_eq!(pct[0].title, "Saved 50% on hosting");

    let under = repo::items::search(&pool, "_", None, None, None, 50, 0).await.unwrap();
    assert!(under.is_empty(), "literal _ must not act as wildcard");
}

#[tokio::test]
async fn items_search_composes_with_filters() {
    let pool = db::open_memory().await.expect("open in-memory db");
    let sid_a = make_src(&pool, "https://a.example/feed", "A").await;
    let sid_b = make_src(&pool, "https://b.example/feed", "B").await;

    repo::items::insert_many(
        &pool,
        vec![
            mk_item(sid_a, "rust in source A read", "x", 100),
            mk_item(sid_a, "rust in source A unread", "x", 200),
            mk_item(sid_b, "rust in source B unread", "x", 300),
        ],
    )
    .await
    .unwrap();

    let all = repo::items::list(&pool, Some(sid_a), None, None, 100, 0).await.unwrap();
    let read_iid = all
        .iter()
        .find(|i| i.title == "rust in source A read")
        .unwrap()
        .iid;
    repo::items::mark_read(&pool, read_iid, true).await.unwrap();

    let scoped = repo::items::search(&pool, "rust", Some(sid_a), None, None, 50, 0).await.unwrap();
    assert_eq!(scoped.len(), 2, "source filter applies");

    let scoped_unread = repo::items::search(&pool, "rust", Some(sid_a), Some(false), None, 50, 0)
        .await
        .unwrap();
    assert_eq!(scoped_unread.len(), 1);
    assert_eq!(scoped_unread[0].title, "rust in source A unread");
}
