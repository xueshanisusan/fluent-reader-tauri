-- Feed ingestion: HTTP cache headers on sources + dedup on items(source_id, link).
-- Dedup uses link (not guid) because we have no guid column yet; most feeds have
-- stable links. ON CONFLICT DO NOTHING in inserts relies on this unique index.

ALTER TABLE sources ADD COLUMN etag TEXT;
ALTER TABLE sources ADD COLUMN last_modified TEXT;

-- Replace the non-unique dedup index with a UNIQUE constraint over (source_id, link).
-- The old idx_items_dedup (source_id, title, date_ms) was advisory; the new index
-- backs ON CONFLICT and prevents concurrent-refresh duplicates at the row level.
DROP INDEX IF EXISTS idx_items_dedup;
CREATE UNIQUE INDEX idx_items_source_link ON items(source_id, link);

UPDATE schema_meta SET value = '2' WHERE key = 'version';
