use fluent_reader_lib::db;
use fluent_reader_lib::models::{NewItem, NewRule, NewSource, SourceRule};
use fluent_reader_lib::repo;
use fluent_reader_lib::rules::{self, MASK_CREATOR, MASK_SNIPPET, MASK_TITLE};

fn mk_rule(position: i64, mask: i64, search: &str, m: bool) -> SourceRule {
    SourceRule {
        rid: 0,
        source_id: 0,
        position,
        filter_type_mask: mask,
        filter_search: search.into(),
        filter_match: m,
        action_read: None,
        action_star: None,
        action_hide: None,
        action_notify: None,
    }
}

fn mk_item(title: &str, snippet: Option<&str>, creator: Option<&str>) -> NewItem {
    NewItem {
        source_id: 0,
        title: title.into(),
        link: format!("https://example.com/{}", title),
        date_ms: 0,
        thumb: None,
        content: None,
        snippet: snippet.map(|s| s.into()),
        creator: creator.map(|s| s.into()),
        guid: None,
        ..Default::default()
    }
}

#[test]
fn evaluate_title_substring_case_insensitive() {
    let mut rule = mk_rule(0, MASK_TITLE, "Rust", true);
    rule.action_read = Some(1);
    let item = mk_item("rust 1.85 release notes", None, None);
    let act = rules::evaluate(&rule, &item).expect("should match");
    assert_eq!(act.has_read, Some(true));
    assert_eq!(act.starred, None);
}

#[test]
fn evaluate_multiple_fields_or_semantics() {
    let mut rule = mk_rule(0, MASK_TITLE | MASK_SNIPPET, "tokio", true);
    rule.action_hide = Some(1);
    let item = mk_item("unrelated title", Some("a tokio deep-dive"), None);
    let act = rules::evaluate(&rule, &item).expect("snippet hit");
    assert_eq!(act.hidden, Some(true));
}

#[test]
fn evaluate_creator_match() {
    let mut rule = mk_rule(0, MASK_CREATOR, "alice", true);
    rule.action_star = Some(1);
    let item = mk_item("post", None, Some("Alice"));
    let act = rules::evaluate(&rule, &item).expect("creator hit");
    assert_eq!(act.starred, Some(true));
}

#[test]
fn evaluate_filter_match_false_inverts() {
    let mut rule = mk_rule(0, MASK_TITLE, "spam", false);
    rule.action_read = Some(1);
    let clean = mk_item("interesting article", None, None);
    let spam = mk_item("get rich quick spam", None, None);
    assert!(rules::evaluate(&rule, &clean).is_some(), "non-match fires");
    assert!(rules::evaluate(&rule, &spam).is_none(), "match doesn't fire");
}

#[test]
fn evaluate_zero_mask_never_matches() {
    let rule = mk_rule(0, 0, "anything", true);
    let item = mk_item("anything", Some("anything"), Some("anything"));
    assert!(rules::evaluate(&rule, &item).is_none());
}

#[test]
fn apply_all_overlays_actions_later_wins() {
    let mut r1 = mk_rule(0, MASK_TITLE, "release", true);
    r1.action_read = Some(1);
    r1.action_star = Some(1);
    let mut r2 = mk_rule(1, MASK_TITLE, "release", true);
    r2.action_read = Some(0); // later rule unsets has_read
    let mut items = vec![mk_item("Rust 1.85 release", None, None)];
    rules::apply_all(&[r1, r2], &mut items);
    assert_eq!(items[0].has_read, false, "later rule's action wins");
    assert_eq!(items[0].starred, true, "earlier action preserved if later None");
}

#[test]
fn apply_all_none_actions_dont_clobber() {
    let mut r = mk_rule(0, MASK_TITLE, "release", true);
    r.action_read = Some(1);
    // action_star/hide/notify left None
    let mut items = vec![NewItem {
        starred: true, // pre-set
        ..mk_item("release", None, None)
    }];
    rules::apply_all(&[r], &mut items);
    assert_eq!(items[0].has_read, true);
    assert_eq!(items[0].starred, true, "None action preserves pre-set field");
}

#[tokio::test]
async fn ingest_apply_stamps_hidden_and_repo_filters_it() {
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

    let _rule = repo::rules::create(
        &pool,
        NewRule {
            source_id: src.sid,
            position: 0,
            filter_type_mask: MASK_TITLE,
            filter_search: "spam".into(),
            filter_match: true,
            action_read: None,
            action_star: None,
            action_hide: Some(1),
            action_notify: None,
        },
    )
    .await
    .unwrap();

    let rules_for_src = repo::rules::list_for_source(&pool, src.sid).await.unwrap();
    let mut items = vec![
        mk_item("clean post", None, None),
        mk_item("spam post", None, None),
    ];
    for it in &mut items {
        it.source_id = src.sid;
    }
    rules::apply_all(&rules_for_src, &mut items);
    assert_eq!(items[0].hidden, false);
    assert_eq!(items[1].hidden, true);

    let mut tx = pool.begin().await.unwrap();
    repo::items::insert_dedup_in_tx(&mut tx, &items).await.unwrap();
    tx.commit().await.unwrap();

    let visible = repo::items::list(&pool, Some(src.sid), None, None, 100, 0).await.unwrap();
    assert_eq!(visible.len(), 1, "hidden item filtered out of list");
    assert_eq!(visible[0].title, "clean post");

    let counts = repo::items::unread_counts(&pool).await.unwrap();
    assert_eq!(counts.len(), 1);
    assert_eq!(counts[0].count, 1, "hidden item not counted as unread");
}
