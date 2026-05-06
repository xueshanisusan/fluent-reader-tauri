-- v2 initial schema. 1NF/2NF/3NF normalized; no migration from v1 (greenfield).
-- Times stored as INTEGER unix milliseconds. Booleans as INTEGER 0/1.
-- snake_case columns; iid/sid/gid/rid PKs.

CREATE TABLE schema_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT INTO schema_meta (key, value) VALUES
    ('version', '1'),
    ('created_at_ms', CAST(strftime('%s', 'now') AS INTEGER) * 1000);

CREATE TABLE groups (
    gid      INTEGER PRIMARY KEY AUTOINCREMENT,
    name     TEXT    NOT NULL,
    expanded INTEGER NOT NULL DEFAULT 1,
    position INTEGER NOT NULL
);

CREATE TABLE sources (
    sid             INTEGER PRIMARY KEY AUTOINCREMENT,
    url             TEXT    NOT NULL UNIQUE,
    icon_url        TEXT,
    name            TEXT    NOT NULL,
    open_target     INTEGER NOT NULL DEFAULT 0,
    last_fetched_ms INTEGER NOT NULL DEFAULT 0,
    service_ref     TEXT,
    fetch_frequency INTEGER NOT NULL DEFAULT 0,
    text_dir        INTEGER NOT NULL DEFAULT 0,
    hidden          INTEGER NOT NULL DEFAULT 0,
    group_id        INTEGER REFERENCES groups(gid) ON DELETE SET NULL,
    position        INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_sources_group ON sources(group_id, position);
CREATE INDEX idx_sources_service_ref ON sources(service_ref) WHERE service_ref IS NOT NULL;

CREATE TABLE source_rules (
    rid              INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id        INTEGER NOT NULL REFERENCES sources(sid) ON DELETE CASCADE,
    position         INTEGER NOT NULL,
    filter_type_mask INTEGER NOT NULL,
    filter_search    TEXT    NOT NULL DEFAULT '',
    filter_match     INTEGER NOT NULL DEFAULT 1,
    action_read      INTEGER,
    action_star      INTEGER,
    action_hide      INTEGER,
    action_notify    INTEGER
);

CREATE INDEX idx_source_rules_source ON source_rules(source_id, position);

CREATE TABLE items (
    iid             INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id       INTEGER NOT NULL REFERENCES sources(sid) ON DELETE CASCADE,
    title           TEXT    NOT NULL,
    link            TEXT    NOT NULL,
    date_ms         INTEGER NOT NULL,
    fetched_date_ms INTEGER NOT NULL,
    thumb           TEXT,
    content         TEXT    NOT NULL DEFAULT '',
    snippet         TEXT    NOT NULL DEFAULT '',
    creator         TEXT,
    has_read        INTEGER NOT NULL DEFAULT 0,
    starred         INTEGER NOT NULL DEFAULT 0,
    hidden          INTEGER NOT NULL DEFAULT 0,
    notify          INTEGER NOT NULL DEFAULT 0,
    service_ref     TEXT
);

CREATE INDEX idx_items_source_date ON items(source_id, date_ms DESC);
CREATE INDEX idx_items_unread ON items(source_id, has_read) WHERE has_read = 0;
CREATE INDEX idx_items_dedup ON items(source_id, title, date_ms);
CREATE INDEX idx_items_service_ref ON items(service_ref) WHERE service_ref IS NOT NULL;
