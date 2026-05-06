use fluent_reader_lib::db;

#[tokio::test]
async fn schema_smoke() {
    let pool = db::open_memory().await.expect("open in-memory db");

    let version: String = sqlx::query_scalar("SELECT value FROM schema_meta WHERE key = 'version'")
        .fetch_one(&pool)
        .await
        .expect("schema_meta version");
    assert_eq!(version, "1");

    let gid: i64 = sqlx::query_scalar(
        "INSERT INTO groups (name, position) VALUES ('Tech', 0) RETURNING gid",
    )
    .fetch_one(&pool)
    .await
    .expect("insert group");

    let sid_grouped: i64 = sqlx::query_scalar(
        "INSERT INTO sources (url, name, group_id, position) VALUES (?, ?, ?, ?) RETURNING sid",
    )
    .bind("https://hnrss.org/frontpage")
    .bind("Hacker News")
    .bind(gid)
    .bind(0)
    .fetch_one(&pool)
    .await
    .expect("insert grouped source");

    let sid_ungrouped: i64 = sqlx::query_scalar(
        "INSERT INTO sources (url, name, position) VALUES (?, ?, ?) RETURNING sid",
    )
    .bind("https://example.com/feed.xml")
    .bind("Example")
    .bind(1)
    .fetch_one(&pool)
    .await
    .expect("insert ungrouped source");

    let url_dup = sqlx::query("INSERT INTO sources (url, name, position) VALUES (?, ?, ?)")
        .bind("https://hnrss.org/frontpage")
        .bind("Dup")
        .bind(2)
        .execute(&pool)
        .await;
    assert!(url_dup.is_err(), "UNIQUE on sources.url should reject duplicate");

    let _rid: i64 = sqlx::query_scalar(
        "INSERT INTO source_rules \
            (source_id, position, filter_type_mask, filter_search, filter_match, action_read, action_star) \
            VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING rid",
    )
    .bind(sid_grouped)
    .bind(0)
    .bind(0)
    .bind("rust")
    .bind(1)
    .bind(1)
    .bind(Option::<i64>::None)
    .fetch_one(&pool)
    .await
    .expect("insert rule");

    let now_ms: i64 = 1714896000000;
    for i in 0..5_i64 {
        sqlx::query(
            "INSERT INTO items \
                (source_id, title, link, date_ms, fetched_date_ms, has_read) \
                VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(sid_grouped)
        .bind(format!("Item {}", i))
        .bind(format!("https://example.com/{}", i))
        .bind(now_ms + i)
        .bind(now_ms)
        .bind(if i < 3 { 0_i64 } else { 1 })
        .execute(&pool)
        .await
        .expect("insert item");
    }

    let feed: Vec<(i64, String)> = sqlx::query_as(
        "SELECT iid, title FROM items WHERE source_id = ? ORDER BY date_ms DESC",
    )
    .bind(sid_grouped)
    .fetch_all(&pool)
    .await
    .expect("feed list query");
    assert_eq!(feed.len(), 5);
    assert_eq!(feed[0].1, "Item 4");
    assert_eq!(feed[4].1, "Item 0");

    let unread_per_source: Vec<(i64, i64)> = sqlx::query_as(
        "SELECT source_id, COUNT(*) FROM items WHERE has_read = 0 GROUP BY source_id",
    )
    .fetch_all(&pool)
    .await
    .expect("unread count query");
    assert_eq!(unread_per_source.len(), 1);
    assert_eq!(unread_per_source[0].0, sid_grouped);
    assert_eq!(unread_per_source[0].1, 3);

    let dup_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM items WHERE source_id = ? AND title = ? AND date_ms = ?",
    )
    .bind(sid_grouped)
    .bind("Item 0")
    .bind(now_ms)
    .fetch_one(&pool)
    .await
    .expect("dedup query");
    assert_eq!(dup_count, 1);

    sqlx::query("DELETE FROM groups WHERE gid = ?")
        .bind(gid)
        .execute(&pool)
        .await
        .expect("delete group");
    let orphaned_group_id: Option<i64> =
        sqlx::query_scalar("SELECT group_id FROM sources WHERE sid = ?")
            .bind(sid_grouped)
            .fetch_one(&pool)
            .await
            .expect("read orphaned source group_id");
    assert_eq!(orphaned_group_id, None, "ON DELETE SET NULL should null group_id");

    sqlx::query("DELETE FROM sources WHERE sid = ?")
        .bind(sid_grouped)
        .execute(&pool)
        .await
        .expect("delete source");
    let remaining_items: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM items WHERE source_id = ?",
    )
    .bind(sid_grouped)
    .fetch_one(&pool)
    .await
    .expect("count items after source delete");
    assert_eq!(remaining_items, 0, "ON DELETE CASCADE should remove items");

    let remaining_rules: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM source_rules WHERE source_id = ?",
    )
    .bind(sid_grouped)
    .fetch_one(&pool)
    .await
    .expect("count rules after source delete");
    assert_eq!(remaining_rules, 0, "ON DELETE CASCADE should remove rules");

    let still_alive: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sources WHERE sid = ?")
        .bind(sid_ungrouped)
        .fetch_one(&pool)
        .await
        .expect("count ungrouped source");
    assert_eq!(still_alive, 1, "ungrouped source untouched by group/source deletes above");
}
