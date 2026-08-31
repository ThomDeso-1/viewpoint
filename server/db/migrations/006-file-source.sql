-- Source exam requests from a scanned folder of files, not only Gmail.
--
-- Additive only, on purpose. `gmail_message_id` stays as the table's
-- NOT NULL UNIQUE column: SQLite cannot drop a UNIQUE column in place, and
-- the migration runner wraps every migration in a transaction where
-- `PRAGMA foreign_keys` / `PRAGMA legacy_alter_table` are no-ops — so a
-- rename-and-rebuild here would silently rewrite wave_invoices' foreign key
-- to the dropped table and null its rows. File-sourced rows repeat their
-- `source_ref` in `gmail_message_id` to satisfy the constraint; a later
-- migration can retire the column once a FK-safe rebuild path exists.

-- Existing rows are all Gmail; new file rows set `source` explicitly.
ALTER TABLE exam_requests ADD COLUMN source TEXT NOT NULL DEFAULT 'gmail';
ALTER TABLE exam_requests ADD COLUMN source_ref TEXT;
ALTER TABLE exam_requests ADD COLUMN source_label TEXT;

UPDATE exam_requests SET source_ref = gmail_message_id WHERE source_ref IS NULL;
UPDATE exam_requests SET source_label = subject WHERE source_label IS NULL;

-- Same idempotency role gmail_message_id had: re-reading a source can only
-- ever find the existing row, never create a second.
CREATE UNIQUE INDEX IF NOT EXISTS idx_exam_requests_source_ref ON exam_requests(source_ref);

-- The Gmail poll watermark is no longer used.
DELETE FROM app_config WHERE key = 'gmail_last_poll_at';

-- One row per file the scanner has read. A file is re-read only when its
-- content hash changes; a file that failed to parse backs off on
-- retry_count / updated_at like the other queues (see platform/backoff.ts).
CREATE TABLE IF NOT EXISTS processed_source_files (
  relative_path  TEXT PRIMARY KEY,
  content_hash   TEXT NOT NULL,
  patients_found INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'ok',   -- ok | error
  last_error     TEXT,
  retry_count    INTEGER NOT NULL DEFAULT 0,
  first_seen_at  TEXT NOT NULL,
  processed_at   TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
