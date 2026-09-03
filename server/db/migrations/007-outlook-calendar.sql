-- The appointment calendar moves from Google Calendar to the Outlook /
-- Microsoft 365 calendar (Phase 1 of the Outlook sync rebuild).
--
-- Additive only, on the same reasoning as migration 006: the runner wraps
-- every migration in a transaction where `PRAGMA legacy_alter_table` is a
-- no-op, so a rename-and-rebuild of `appointments` would silently rewrite
-- the foreign keys that `exam_requests`, `wave_invoices`, `reminders` and
-- `eligibility_checks` hold against it. `google_event_id` therefore stays
-- as a column — nothing reads it after this, and a later FK-safe rebuild
-- can retire it.

-- SQLite cannot `ADD COLUMN ... UNIQUE`, so `ms_event_id` is a plain column
-- with a separate unique index — the same idempotency guarantee
-- `google_event_id`'s inline UNIQUE gave calendar polling.
ALTER TABLE appointments ADD COLUMN ms_event_id      TEXT;
ALTER TABLE appointments ADD COLUMN ical_uid         TEXT;
ALTER TABLE appointments ADD COLUMN provider_etag    TEXT;
ALTER TABLE appointments ADD COLUMN web_link         TEXT;
ALTER TABLE appointments ADD COLUMN is_recurring     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE appointments ADD COLUMN series_master_id TEXT;
ALTER TABLE appointments ADD COLUMN last_synced_at   TEXT;
-- synced | pending_push | push_failed — drives the Phase 2 push queue.
ALTER TABLE appointments ADD COLUMN sync_state       TEXT NOT NULL DEFAULT 'synced';

CREATE UNIQUE INDEX IF NOT EXISTS idx_appointments_ms_event ON appointments(ms_event_id);

-- One row per calendar the app syncs (normally just 'primary', or the
-- MICROSOFT_CALENDAR_ID override). `delta_link` is the `@odata.deltaToken`
-- from the last successful `calendarView/delta` walk; the window is the
-- fixed date range that delta query needs.
CREATE TABLE IF NOT EXISTS calendar_sync (
  calendar_id       TEXT PRIMARY KEY,
  delta_link        TEXT,
  window_start      TEXT,
  window_end        TEXT,
  last_full_sync_at TEXT,
  last_delta_at     TEXT,
  updated_at        TEXT NOT NULL
);
