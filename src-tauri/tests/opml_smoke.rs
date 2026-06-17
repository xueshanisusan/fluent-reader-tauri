use fluent_reader_lib::db;
use fluent_reader_lib::models::NewSource;
use fluent_reader_lib::opml;
use fluent_reader_lib::repo;

const SAMPLE: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<opml version="1.0">
  <head><title>Subscriptions</title></head>
  <body>
    <outline type="rss" text="HN" title="Hacker News" xmlUrl="https://hnrss.org/frontpage" />
    <outline text="Devs" title="Devs">
      <outline type="rss" text="Rust" title="Rust Blog" xmlUrl="https://blog.rust-lang.org/feed.xml" />
      <outline type="rss" text="Go" title="Go Blog" xmlUrl="https://go.dev/blog/feed.atom" />
    </outline>
    <outline text="Nested">
      <outline text="Inner">
        <outline type="rss" title="Deep" xmlUrl="https://example.com/deep.xml" />
      </outline>
    </outline>
  </body>
</opml>
"#;

#[test]
fn parse_extracts_feeds_with_group_assignment() {
    let parsed = opml::parse(SAMPLE).expect("parse ok");
    let by_url = |u: &str| parsed.iter().find(|f| f.url == u).cloned();

    let hn = by_url("https://hnrss.org/frontpage").expect("hn");
    assert_eq!(hn.group, None);
    assert_eq!(hn.name, "Hacker News");

    let rust = by_url("https://blog.rust-lang.org/feed.xml").expect("rust");
    assert_eq!(rust.group.as_deref(), Some("Devs"));
    assert_eq!(rust.name, "Rust Blog");

    // Nested-inside-nested feed should attach to the closest-ancestor group,
    // which is "Inner". (closest_group walks up the stack.)
    let deep = by_url("https://example.com/deep.xml").expect("deep");
    assert_eq!(deep.group.as_deref(), Some("Inner"));

    assert_eq!(parsed.len(), 4);
}

#[test]
fn parse_rejects_malformed_xml() {
    let bad = "<opml><body><outline type=\"rss\" xmlUrl=\"x\"";
    assert!(opml::parse(bad).is_err());
}

#[tokio::test]
async fn import_then_export_round_trips_feeds_and_groups() {
    let pool = db::open_memory().await.expect("open mem db");

    let summary = opml::import(&pool, SAMPLE).await.expect("import ok");
    assert_eq!(summary.sources_added, 4);
    assert_eq!(summary.sources_skipped, 0);
    // Devs + Nested + Inner. Anchor groups for top-level + each container that
    // owns a feed via closest-ancestor.
    assert_eq!(summary.groups_created, 2);

    let sources = repo::sources::list(&pool).await.expect("list sources");
    assert!(sources.iter().any(|s| s.url == "https://hnrss.org/frontpage"
        && s.group_id.is_none()));
    let rust = sources
        .iter()
        .find(|s| s.url == "https://blog.rust-lang.org/feed.xml")
        .unwrap();
    assert!(rust.group_id.is_some(), "rust feed should be grouped");

    let xml = opml::export(&pool).await.expect("export ok");
    let re_parsed = opml::parse(&xml).expect("re-parse own export");
    assert_eq!(re_parsed.len(), 4);
    assert!(re_parsed
        .iter()
        .any(|f| f.url == "https://hnrss.org/frontpage" && f.group.is_none()));
    assert!(re_parsed
        .iter()
        .any(|f| f.url == "https://blog.rust-lang.org/feed.xml"
            && f.group.as_deref() == Some("Devs")));
}

#[tokio::test]
async fn import_skips_existing_urls() {
    let pool = db::open_memory().await.expect("open mem db");
    repo::sources::create(
        &pool,
        NewSource {
            url: "https://hnrss.org/frontpage".to_string(),
            name: "HN existing".to_string(),
            icon_url: None,
            group_id: None,
            open_target: None,
            fetch_frequency: None,
            text_dir: None,
        },
    )
    .await
    .expect("seed");

    let summary = opml::import(&pool, SAMPLE).await.expect("import");
    assert_eq!(summary.sources_added, 3);
    assert_eq!(summary.sources_skipped, 1);

    let after = repo::sources::list(&pool).await.unwrap();
    // The pre-existing one should keep its name, not be overwritten.
    let hn = after
        .iter()
        .find(|s| s.url == "https://hnrss.org/frontpage")
        .unwrap();
    assert_eq!(hn.name, "HN existing");
}

#[tokio::test]
async fn export_with_no_data_emits_valid_empty_opml() {
    let pool = db::open_memory().await.expect("open mem db");
    let xml = opml::export(&pool).await.expect("export");
    let parsed = opml::parse(&xml).expect("re-parse");
    assert_eq!(parsed.len(), 0);
}
