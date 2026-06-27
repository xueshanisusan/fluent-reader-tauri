use crate::models::*;
use sqlx::SqlitePool;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

pub mod groups {
    use super::*;

    pub async fn list(pool: &SqlitePool) -> sqlx::Result<Vec<Group>> {
        sqlx::query_as("SELECT gid, name, expanded, position FROM groups ORDER BY position, gid")
            .fetch_all(pool)
            .await
    }

    pub async fn create(pool: &SqlitePool, name: &str) -> sqlx::Result<Group> {
        let next_pos: i64 =
            sqlx::query_scalar("SELECT COALESCE(MAX(position) + 1, 0) FROM groups")
                .fetch_one(pool)
                .await?;
        sqlx::query_as(
            "INSERT INTO groups (name, position) VALUES (?, ?) \
             RETURNING gid, name, expanded, position",
        )
        .bind(name)
        .bind(next_pos)
        .fetch_one(pool)
        .await
    }

    pub async fn rename(pool: &SqlitePool, gid: i64, name: &str) -> sqlx::Result<()> {
        sqlx::query("UPDATE groups SET name = ? WHERE gid = ?")
            .bind(name)
            .bind(gid)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn set_expanded(pool: &SqlitePool, gid: i64, expanded: bool) -> sqlx::Result<()> {
        sqlx::query("UPDATE groups SET expanded = ? WHERE gid = ?")
            .bind(expanded)
            .bind(gid)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn set_position(pool: &SqlitePool, gid: i64, position: i64) -> sqlx::Result<()> {
        sqlx::query("UPDATE groups SET position = ? WHERE gid = ?")
            .bind(position)
            .bind(gid)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn delete(pool: &SqlitePool, gid: i64) -> sqlx::Result<()> {
        sqlx::query("DELETE FROM groups WHERE gid = ?")
            .bind(gid)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn find_or_create_in_tx(
        tx: &mut sqlx::SqliteConnection,
        name: &str,
    ) -> sqlx::Result<Group> {
        if let Some(existing) = sqlx::query_as::<_, Group>(
            "SELECT gid, name, expanded, position FROM groups WHERE name = ?",
        )
        .bind(name)
        .fetch_optional(&mut *tx)
        .await?
        {
            return Ok(existing);
        }
        let next_pos: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(position) + 1, 0) FROM groups",
        )
        .fetch_one(&mut *tx)
        .await?;
        sqlx::query_as(
            "INSERT INTO groups (name, position) VALUES (?, ?) \
             RETURNING gid, name, expanded, position",
        )
        .bind(name)
        .bind(next_pos)
        .fetch_one(&mut *tx)
        .await
    }
}

pub mod sources {
    use super::*;

    pub async fn list(pool: &SqlitePool) -> sqlx::Result<Vec<Source>> {
        sqlx::query_as(
            "SELECT sid, url, icon_url, name, open_target, last_fetched_ms, service_ref, \
                    fetch_frequency, text_dir, hidden, group_id, position, etag, last_modified \
             FROM sources \
             ORDER BY group_id IS NULL, group_id, position, sid",
        )
        .fetch_all(pool)
        .await
    }

    pub async fn get(pool: &SqlitePool, sid: i64) -> sqlx::Result<Source> {
        sqlx::query_as(
            "SELECT sid, url, icon_url, name, open_target, last_fetched_ms, service_ref, \
                    fetch_frequency, text_dir, hidden, group_id, position, etag, last_modified \
             FROM sources WHERE sid = ?",
        )
        .bind(sid)
        .fetch_one(pool)
        .await
    }

    pub async fn create(pool: &SqlitePool, input: NewSource) -> sqlx::Result<Source> {
        let next_pos: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(position) + 1, 0) FROM sources WHERE group_id IS ?",
        )
        .bind(input.group_id)
        .fetch_one(pool)
        .await?;
        sqlx::query_as(
            "INSERT INTO sources \
                (url, name, icon_url, group_id, open_target, fetch_frequency, text_dir, position) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?) \
             RETURNING sid, url, icon_url, name, open_target, last_fetched_ms, service_ref, \
                       fetch_frequency, text_dir, hidden, group_id, position, etag, last_modified",
        )
        .bind(&input.url)
        .bind(&input.name)
        .bind(&input.icon_url)
        .bind(input.group_id)
        .bind(input.open_target.unwrap_or(0))
        .bind(input.fetch_frequency.unwrap_or(0))
        .bind(input.text_dir.unwrap_or(0))
        .bind(next_pos)
        .fetch_one(pool)
        .await
    }

    pub async fn rename(pool: &SqlitePool, sid: i64, name: &str) -> sqlx::Result<()> {
        sqlx::query("UPDATE sources SET name = ? WHERE sid = ?")
            .bind(name)
            .bind(sid)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn set_group(
        pool: &SqlitePool,
        sid: i64,
        group_id: Option<i64>,
    ) -> sqlx::Result<()> {
        sqlx::query("UPDATE sources SET group_id = ? WHERE sid = ?")
            .bind(group_id)
            .bind(sid)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn set_icon_url(
        pool: &SqlitePool,
        sid: i64,
        icon_url: Option<String>,
    ) -> sqlx::Result<()> {
        sqlx::query("UPDATE sources SET icon_url = ? WHERE sid = ?")
            .bind(icon_url)
            .bind(sid)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn set_fetch_frequency(
        pool: &SqlitePool,
        sid: i64,
        fetch_frequency: i64,
    ) -> sqlx::Result<()> {
        sqlx::query("UPDATE sources SET fetch_frequency = ? WHERE sid = ?")
            .bind(fetch_frequency)
            .bind(sid)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn set_hidden(pool: &SqlitePool, sid: i64, hidden: bool) -> sqlx::Result<()> {
        sqlx::query("UPDATE sources SET hidden = ? WHERE sid = ?")
            .bind(hidden)
            .bind(sid)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn set_last_fetched(
        pool: &SqlitePool,
        sid: i64,
        last_fetched_ms: i64,
    ) -> sqlx::Result<()> {
        sqlx::query("UPDATE sources SET last_fetched_ms = ? WHERE sid = ?")
            .bind(last_fetched_ms)
            .bind(sid)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn delete(pool: &SqlitePool, sid: i64) -> sqlx::Result<()> {
        sqlx::query("DELETE FROM sources WHERE sid = ?")
            .bind(sid)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn set_cache_headers_in_tx(
        tx: &mut sqlx::SqliteConnection,
        sid: i64,
        etag: Option<&str>,
        last_modified: Option<&str>,
    ) -> sqlx::Result<()> {
        sqlx::query("UPDATE sources SET etag = ?, last_modified = ? WHERE sid = ?")
            .bind(etag)
            .bind(last_modified)
            .bind(sid)
            .execute(&mut *tx)
            .await?;
        Ok(())
    }

    pub async fn set_last_fetched_in_tx(
        tx: &mut sqlx::SqliteConnection,
        sid: i64,
        last_fetched_ms: i64,
    ) -> sqlx::Result<()> {
        sqlx::query("UPDATE sources SET last_fetched_ms = ? WHERE sid = ?")
            .bind(last_fetched_ms)
            .bind(sid)
            .execute(&mut *tx)
            .await?;
        Ok(())
    }

    // For OPML import: try to insert; if the URL already exists (UNIQUE),
    // skip silently. Returns true iff a row was inserted.
    pub async fn insert_or_ignore_in_tx(
        tx: &mut sqlx::SqliteConnection,
        url: &str,
        name: &str,
        group_id: Option<i64>,
    ) -> sqlx::Result<bool> {
        let next_pos: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(position) + 1, 0) FROM sources WHERE group_id IS ?",
        )
        .bind(group_id)
        .fetch_one(&mut *tx)
        .await?;
        let res = sqlx::query(
            "INSERT OR IGNORE INTO sources (url, name, group_id, position) \
             VALUES (?, ?, ?, ?)",
        )
        .bind(url)
        .bind(name)
        .bind(group_id)
        .bind(next_pos)
        .execute(&mut *tx)
        .await?;
        Ok(res.rows_affected() == 1)
    }
}

pub mod rules {
    use super::*;

    pub async fn list_for_source(
        pool: &SqlitePool,
        source_id: i64,
    ) -> sqlx::Result<Vec<SourceRule>> {
        sqlx::query_as(
            "SELECT rid, source_id, position, filter_type_mask, filter_search, filter_match, \
                    action_read, action_star, action_hide, action_notify \
             FROM source_rules WHERE source_id = ? ORDER BY position, rid",
        )
        .bind(source_id)
        .fetch_all(pool)
        .await
    }

    pub async fn create(pool: &SqlitePool, input: NewRule) -> sqlx::Result<SourceRule> {
        sqlx::query_as(
            "INSERT INTO source_rules \
                (source_id, position, filter_type_mask, filter_search, filter_match, \
                 action_read, action_star, action_hide, action_notify) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) \
             RETURNING rid, source_id, position, filter_type_mask, filter_search, filter_match, \
                       action_read, action_star, action_hide, action_notify",
        )
        .bind(input.source_id)
        .bind(input.position)
        .bind(input.filter_type_mask)
        .bind(input.filter_search)
        .bind(input.filter_match)
        .bind(input.action_read)
        .bind(input.action_star)
        .bind(input.action_hide)
        .bind(input.action_notify)
        .fetch_one(pool)
        .await
    }

    pub async fn update(pool: &SqlitePool, rid: i64, patch: RulePatch) -> sqlx::Result<()> {
        sqlx::query(
            "UPDATE source_rules SET \
                position = ?, filter_type_mask = ?, filter_search = ?, filter_match = ?, \
                action_read = ?, action_star = ?, action_hide = ?, action_notify = ? \
             WHERE rid = ?",
        )
        .bind(patch.position)
        .bind(patch.filter_type_mask)
        .bind(patch.filter_search)
        .bind(patch.filter_match)
        .bind(patch.action_read)
        .bind(patch.action_star)
        .bind(patch.action_hide)
        .bind(patch.action_notify)
        .bind(rid)
        .execute(pool)
        .await?;
        Ok(())
    }

    pub async fn delete(pool: &SqlitePool, rid: i64) -> sqlx::Result<()> {
        sqlx::query("DELETE FROM source_rules WHERE rid = ?")
            .bind(rid)
            .execute(pool)
            .await?;
        Ok(())
    }
}

pub mod items {
    use super::*;

    pub async fn list(
        pool: &SqlitePool,
        source_id: Option<i64>,
        has_read: Option<bool>,
        starred: Option<bool>,
        limit: i64,
        offset: i64,
    ) -> sqlx::Result<Vec<Item>> {
        let mut sql = String::from(
            "SELECT iid, source_id, title, link, date_ms, fetched_date_ms, thumb, content, \
                    snippet, creator, has_read, starred, hidden, notify, service_ref, guid \
             FROM items WHERE hidden = 0",
        );
        if source_id.is_some() {
            sql.push_str(" AND source_id = ?");
        }
        if has_read.is_some() {
            sql.push_str(" AND has_read = ?");
        }
        if starred.is_some() {
            sql.push_str(" AND starred = ?");
        }
        sql.push_str(" ORDER BY date_ms DESC, iid DESC LIMIT ? OFFSET ?");

        let mut q = sqlx::query_as::<_, Item>(&sql);
        if let Some(v) = source_id {
            q = q.bind(v);
        }
        if let Some(v) = has_read {
            q = q.bind(v);
        }
        if let Some(v) = starred {
            q = q.bind(v);
        }
        q.bind(limit).bind(offset).fetch_all(pool).await
    }

    pub async fn search(
        pool: &SqlitePool,
        query: &str,
        source_id: Option<i64>,
        has_read: Option<bool>,
        starred: Option<bool>,
        limit: i64,
        offset: i64,
    ) -> sqlx::Result<Vec<Item>> {
        // Escape LIKE metachars in user input. Backslash must come first.
        let escaped = query
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_");
        let pattern = format!("%{}%", escaped);

        let mut sql = String::from(
            "SELECT iid, source_id, title, link, date_ms, fetched_date_ms, thumb, content, \
                    snippet, creator, has_read, starred, hidden, notify, service_ref, guid \
             FROM items \
             WHERE hidden = 0 AND (title LIKE ? ESCAPE '\\' OR snippet LIKE ? ESCAPE '\\')",
        );
        if source_id.is_some() {
            sql.push_str(" AND source_id = ?");
        }
        if has_read.is_some() {
            sql.push_str(" AND has_read = ?");
        }
        if starred.is_some() {
            sql.push_str(" AND starred = ?");
        }
        sql.push_str(" ORDER BY date_ms DESC, iid DESC LIMIT ? OFFSET ?");

        let mut q = sqlx::query_as::<_, Item>(&sql)
            .bind(pattern.clone())
            .bind(pattern);
        if let Some(v) = source_id {
            q = q.bind(v);
        }
        if let Some(v) = has_read {
            q = q.bind(v);
        }
        if let Some(v) = starred {
            q = q.bind(v);
        }
        q.bind(limit).bind(offset).fetch_all(pool).await
    }

    pub async fn insert_many(pool: &SqlitePool, items: Vec<NewItem>) -> sqlx::Result<u64> {
        if items.is_empty() {
            return Ok(0);
        }
        let fetched = now_ms();
        let mut tx = pool.begin().await?;
        let mut inserted = 0u64;
        for it in items {
            let res = sqlx::query(
                "INSERT INTO items \
                    (source_id, title, link, date_ms, fetched_date_ms, thumb, content, snippet, creator, guid, \
                     has_read, starred, hidden, notify) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(it.source_id)
            .bind(&it.title)
            .bind(&it.link)
            .bind(it.date_ms)
            .bind(fetched)
            .bind(&it.thumb)
            .bind(it.content.unwrap_or_default())
            .bind(it.snippet.unwrap_or_default())
            .bind(&it.creator)
            .bind(&it.guid)
            .bind(it.has_read)
            .bind(it.starred)
            .bind(it.hidden)
            .bind(it.notify)
            .execute(&mut *tx)
            .await?;
            inserted += res.rows_affected();
        }
        tx.commit().await?;
        Ok(inserted)
    }

    pub async fn mark_read(pool: &SqlitePool, iid: i64, has_read: bool) -> sqlx::Result<()> {
        sqlx::query("UPDATE items SET has_read = ? WHERE iid = ?")
            .bind(has_read)
            .bind(iid)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn set_starred(pool: &SqlitePool, iid: i64, starred: bool) -> sqlx::Result<()> {
        sqlx::query("UPDATE items SET starred = ? WHERE iid = ?")
            .bind(starred)
            .bind(iid)
            .execute(pool)
            .await?;
        Ok(())
    }

    pub async fn unread_counts(pool: &SqlitePool) -> sqlx::Result<Vec<UnreadCount>> {
        sqlx::query_as(
            "SELECT source_id, COUNT(*) AS count FROM items \
             WHERE has_read = 0 AND hidden = 0 GROUP BY source_id",
        )
        .fetch_all(pool)
        .await
    }

    /// Items missing a thumbnail that still have content to scan. Used by the
    /// one-shot thumb backfill. `content`/`link` are NOT NULL in the schema, so
    /// the tuple has no Option fields. Column order MUST stay (iid, content,
    /// link) to match the tuple decode and the caller's destructure.
    pub async fn list_thumbless(pool: &SqlitePool) -> sqlx::Result<Vec<(i64, String, String)>> {
        sqlx::query_as::<_, (i64, String, String)>(
            "SELECT iid, content, link FROM items \
             WHERE (thumb IS NULL OR thumb = '') AND content <> ''",
        )
        .fetch_all(pool)
        .await
    }

    /// Apply computed thumbs to existing rows in one tx. `thumb` is unindexed,
    /// so a plain UPDATE touches no unique constraint. Mirrors the loop-in-tx
    /// shape of `insert_dedup_in_tx`.
    pub async fn update_thumbs_in_tx(
        tx: &mut sqlx::SqliteConnection,
        updates: &[(i64, String)],
    ) -> sqlx::Result<u64> {
        let mut updated = 0u64;
        for (iid, thumb) in updates {
            let res = sqlx::query("UPDATE items SET thumb = ? WHERE iid = ?")
                .bind(thumb)
                .bind(iid)
                .execute(&mut *tx)
                .await?;
            updated += res.rows_affected();
        }
        Ok(updated)
    }

    pub async fn insert_dedup_in_tx(
        tx: &mut sqlx::SqliteConnection,
        items: &[NewItem],
    ) -> sqlx::Result<(u64, u64, Vec<bool>)> {
        if items.is_empty() {
            return Ok((0, 0, Vec::new()));
        }
        let fetched = now_ms();
        let mut inserted = 0u64;
        let mut mask = Vec::with_capacity(items.len());
        // INSERT OR IGNORE because we have two unique indexes — (source_id, link)
        // unconditional, and (source_id, guid) partial. ON CONFLICT(target) only
        // accepts one target; OR IGNORE catches either conflict and skips.
        for it in items {
            let res = sqlx::query(
                "INSERT OR IGNORE INTO items \
                    (source_id, title, link, date_ms, fetched_date_ms, thumb, content, snippet, creator, guid, \
                     has_read, starred, hidden, notify) \
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            )
            .bind(it.source_id)
            .bind(&it.title)
            .bind(&it.link)
            .bind(it.date_ms)
            .bind(fetched)
            .bind(&it.thumb)
            .bind(it.content.clone().unwrap_or_default())
            .bind(it.snippet.clone().unwrap_or_default())
            .bind(&it.creator)
            .bind(&it.guid)
            .bind(it.has_read)
            .bind(it.starred)
            .bind(it.hidden)
            .bind(it.notify)
            .execute(&mut *tx)
            .await?;
            let was_inserted = res.rows_affected() == 1;
            mask.push(was_inserted);
            if was_inserted {
                inserted += 1;
            }
        }
        let skipped = items.len() as u64 - inserted;
        Ok((inserted, skipped, mask))
    }
}
