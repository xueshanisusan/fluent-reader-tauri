-- Stronger dedup: add guid column so we catch items whose link mutated
-- (URL params, tracking suffixes, redirect normalization) but identity is
-- stable in the feed's <guid> / atom:id.
--
-- Partial unique index because most legacy feeds don't supply guid; we still
-- keep idx_items_source_link as the fallback dedup path. With two unique
-- indexes the inserter must use INSERT OR IGNORE — ON CONFLICT(target) only
-- accepts a single target.

ALTER TABLE items ADD COLUMN guid TEXT;

CREATE UNIQUE INDEX idx_items_source_guid
    ON items(source_id, guid)
    WHERE guid IS NOT NULL;

UPDATE schema_meta SET value = '3' WHERE key = 'version';
