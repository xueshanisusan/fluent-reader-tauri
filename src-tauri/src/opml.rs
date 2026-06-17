// OPML 1.0/2.0 import/export. Sticks to the de-facto subset every reader
// emits/accepts: <opml><body><outline ...>...</outline></body></opml>, where
// a feed is `<outline type="rss" xmlUrl="..." text="..."/>` and a group is a
// container `<outline text="..."> children </outline>`.
//
// On import we flatten nesting deeper than one level — groups inside groups
// land in the closest top-level group. Duplicate URLs are skipped (UNIQUE
// constraint on sources.url; we use INSERT OR IGNORE).

use crate::commands::AppState;
use crate::models::{Group, Source};
use crate::repo;
use quick_xml::events::{BytesDecl, BytesEnd, BytesStart, BytesText, Event};
use quick_xml::reader::Reader;
use quick_xml::writer::Writer;
use serde::Serialize;
use std::io::Cursor;
use tauri::State;

#[derive(Debug, Clone, Serialize, thiserror::Error)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OpmlError {
    #[error("parse: {message}")]
    Parse { message: String },
    #[error("db: {message}")]
    Db { message: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub groups_created: u64,
    pub sources_added: u64,
    pub sources_skipped: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedFeed {
    pub url: String,
    pub name: String,
    pub group: Option<String>,
}

// Parse OPML XML to a flat list of (group?, url, name). Public for tests.
pub fn parse(xml: &str) -> Result<Vec<ParsedFeed>, OpmlError> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(true);

    let mut feeds: Vec<ParsedFeed> = Vec::new();
    // outline-element stack; entries are Some(group_name) for a group outline,
    // None for a feed outline (we don't push for empty/self-closed feeds).
    let mut stack: Vec<Option<String>> = Vec::new();
    let mut in_body = false;
    let mut buf = Vec::new();

    loop {
        match reader
            .read_event_into(&mut buf)
            .map_err(|e| OpmlError::Parse { message: e.to_string() })?
        {
            Event::Eof => break,
            Event::Start(e) => {
                let name = e.name().as_ref().to_ascii_lowercase();
                if name == b"body" {
                    in_body = true;
                } else if name == b"outline" && in_body {
                    if let Some(feed) = read_outline_attrs(&e, &reader)? {
                        // Feed outline that also has children — treat as feed
                        // and ignore children (rare, malformed).
                        let group = current_group(&stack);
                        feeds.push(ParsedFeed {
                            url: feed.url,
                            name: feed.name,
                            group,
                        });
                        stack.push(None);
                    } else {
                        // Group outline.
                        let title = outline_title(&e, &reader)
                            .unwrap_or_else(|| "Untitled".to_string());
                        stack.push(Some(title));
                    }
                }
            }
            Event::Empty(e) => {
                let name = e.name().as_ref().to_ascii_lowercase();
                if name == b"outline" && in_body {
                    if let Some(feed) = read_outline_attrs(&e, &reader)? {
                        let group = current_group(&stack);
                        feeds.push(ParsedFeed {
                            url: feed.url,
                            name: feed.name,
                            group,
                        });
                    }
                    // Empty group outline (<outline text="Foo"/>) without
                    // children is meaningless — drop it.
                }
            }
            Event::End(e) => {
                let name = e.name().as_ref().to_ascii_lowercase();
                if name == b"body" {
                    in_body = false;
                } else if name == b"outline" && in_body {
                    stack.pop();
                }
            }
            _ => {}
        }
        buf.clear();
    }

    Ok(feeds)
}

// Walks the stack to find the innermost group title. We flatten anything
// deeper than the topmost group into that group (closest-ancestor semantics
// kept simple).
fn current_group(stack: &[Option<String>]) -> Option<String> {
    for entry in stack.iter().rev() {
        if let Some(g) = entry {
            return Some(g.clone());
        }
    }
    None
}

struct OutlineFeed {
    url: String,
    name: String,
}

fn read_outline_attrs(
    e: &BytesStart,
    reader: &Reader<&[u8]>,
) -> Result<Option<OutlineFeed>, OpmlError> {
    let mut url: Option<String> = None;
    let mut title: Option<String> = None;
    let mut text: Option<String> = None;
    let mut is_feed_type = false;

    for attr in e.attributes().with_checks(false) {
        let attr = attr.map_err(|e| OpmlError::Parse {
            message: e.to_string(),
        })?;
        let key = attr.key.as_ref().to_ascii_lowercase();
        let val = attr
            .decode_and_unescape_value(reader.decoder())
            .map_err(|e| OpmlError::Parse {
                message: e.to_string(),
            })?
            .into_owned();
        match key.as_slice() {
            b"xmlurl" => url = Some(val),
            b"title" => title = Some(val),
            b"text" => text = Some(val),
            b"type" => {
                let t = val.to_ascii_lowercase();
                is_feed_type = t == "rss" || t == "atom";
            }
            _ => {}
        }
    }

    match url {
        Some(u) if is_feed_type || !u.is_empty() => Ok(Some(OutlineFeed {
            url: u,
            name: title
                .or(text)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "Untitled".to_string()),
        })),
        _ => Ok(None),
    }
}

fn outline_title(e: &BytesStart, reader: &Reader<&[u8]>) -> Option<String> {
    let mut title: Option<String> = None;
    let mut text: Option<String> = None;
    for attr in e.attributes().with_checks(false).flatten() {
        let key = attr.key.as_ref().to_ascii_lowercase();
        let Ok(val) = attr.decode_and_unescape_value(reader.decoder()) else {
            continue;
        };
        match key.as_slice() {
            b"title" => title = Some(val.into_owned()),
            b"text" => text = Some(val.into_owned()),
            _ => {}
        }
    }
    title.or(text).map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

pub fn serialize(
    groups: &[Group],
    sources: &[Source],
) -> Result<String, OpmlError> {
    let mut writer = Writer::new_with_indent(Cursor::new(Vec::new()), b' ', 2);

    writer
        .write_event(Event::Decl(BytesDecl::new("1.0", Some("UTF-8"), None)))
        .map_err(|e| OpmlError::Parse {
            message: e.to_string(),
        })?;

    let mut opml = BytesStart::new("opml");
    opml.push_attribute(("version", "1.0"));
    writer
        .write_event(Event::Start(opml))
        .map_err(|e| OpmlError::Parse { message: e.to_string() })?;

    // Minimal head.
    writer
        .write_event(Event::Start(BytesStart::new("head")))
        .map_err(|e| OpmlError::Parse { message: e.to_string() })?;
    writer
        .write_event(Event::Start(BytesStart::new("title")))
        .map_err(|e| OpmlError::Parse { message: e.to_string() })?;
    writer
        .write_event(Event::Text(BytesText::new("Subscriptions")))
        .map_err(|e| OpmlError::Parse { message: e.to_string() })?;
    writer
        .write_event(Event::End(BytesEnd::new("title")))
        .map_err(|e| OpmlError::Parse { message: e.to_string() })?;
    writer
        .write_event(Event::End(BytesEnd::new("head")))
        .map_err(|e| OpmlError::Parse { message: e.to_string() })?;

    writer
        .write_event(Event::Start(BytesStart::new("body")))
        .map_err(|e| OpmlError::Parse { message: e.to_string() })?;

    // Ungrouped first.
    for s in sources.iter().filter(|s| s.group_id.is_none()) {
        write_feed_outline(&mut writer, s)?;
    }

    // Then each group.
    for g in groups {
        let mut group_el = BytesStart::new("outline");
        group_el.push_attribute(("text", g.name.as_str()));
        group_el.push_attribute(("title", g.name.as_str()));
        writer
            .write_event(Event::Start(group_el))
            .map_err(|e| OpmlError::Parse { message: e.to_string() })?;

        for s in sources.iter().filter(|s| s.group_id == Some(g.gid)) {
            write_feed_outline(&mut writer, s)?;
        }

        writer
            .write_event(Event::End(BytesEnd::new("outline")))
            .map_err(|e| OpmlError::Parse { message: e.to_string() })?;
    }

    writer
        .write_event(Event::End(BytesEnd::new("body")))
        .map_err(|e| OpmlError::Parse { message: e.to_string() })?;
    writer
        .write_event(Event::End(BytesEnd::new("opml")))
        .map_err(|e| OpmlError::Parse { message: e.to_string() })?;

    String::from_utf8(writer.into_inner().into_inner()).map_err(|e| {
        OpmlError::Parse {
            message: e.to_string(),
        }
    })
}

fn write_feed_outline(
    writer: &mut Writer<Cursor<Vec<u8>>>,
    s: &Source,
) -> Result<(), OpmlError> {
    let mut el = BytesStart::new("outline");
    el.push_attribute(("type", "rss"));
    el.push_attribute(("text", s.name.as_str()));
    el.push_attribute(("title", s.name.as_str()));
    el.push_attribute(("xmlUrl", s.url.as_str()));
    writer
        .write_event(Event::Empty(el))
        .map_err(|e| OpmlError::Parse { message: e.to_string() })?;
    Ok(())
}

pub async fn import(
    pool: &sqlx::SqlitePool,
    xml: &str,
) -> Result<ImportSummary, OpmlError> {
    let parsed = parse(xml)?;

    // Pre-load existing group names before we start the tx — open_memory uses
    // max_connections=1, so holding the tx while asking the pool for another
    // conn would deadlock. (Production pool is 5, but the rule is the same.)
    let existing_names: std::collections::HashSet<String> = repo::groups::list(pool)
        .await
        .map_err(|e| OpmlError::Db { message: e.to_string() })?
        .into_iter()
        .map(|g| g.name)
        .collect();

    let mut tx = pool.begin().await.map_err(|e| OpmlError::Db {
        message: e.to_string(),
    })?;

    let mut groups_created: u64 = 0;
    let mut sources_added: u64 = 0;
    let mut sources_skipped: u64 = 0;

    // Cache group lookups to avoid repeat find_or_create within one import.
    let mut group_cache: std::collections::HashMap<String, i64> =
        std::collections::HashMap::new();

    for feed in parsed {
        let group_id = if let Some(name) = feed.group {
            if let Some(gid) = group_cache.get(&name) {
                Some(*gid)
            } else {
                let was_new = !existing_names.contains(&name)
                    && !group_cache.contains_key(&name);
                let g = repo::groups::find_or_create_in_tx(&mut tx, &name)
                    .await
                    .map_err(|e| OpmlError::Db {
                        message: e.to_string(),
                    })?;
                group_cache.insert(name, g.gid);
                if was_new {
                    groups_created += 1;
                }
                Some(g.gid)
            }
        } else {
            None
        };

        let inserted = repo::sources::insert_or_ignore_in_tx(
            &mut tx,
            &feed.url,
            &feed.name,
            group_id,
        )
        .await
        .map_err(|e| OpmlError::Db { message: e.to_string() })?;
        if inserted {
            sources_added += 1;
        } else {
            sources_skipped += 1;
        }
    }

    tx.commit()
        .await
        .map_err(|e| OpmlError::Db { message: e.to_string() })?;

    Ok(ImportSummary {
        groups_created,
        sources_added,
        sources_skipped,
    })
}

pub async fn export(pool: &sqlx::SqlitePool) -> Result<String, OpmlError> {
    let groups = repo::groups::list(pool)
        .await
        .map_err(|e| OpmlError::Db { message: e.to_string() })?;
    let sources = repo::sources::list(pool)
        .await
        .map_err(|e| OpmlError::Db { message: e.to_string() })?;
    serialize(&groups, &sources)
}

#[tauri::command]
pub async fn feeds_import_opml(
    state: State<'_, AppState>,
    xml: String,
) -> Result<ImportSummary, OpmlError> {
    import(&state.pool, &xml).await
}

#[tauri::command]
pub async fn feeds_export_opml(
    state: State<'_, AppState>,
) -> Result<String, OpmlError> {
    export(&state.pool).await
}
