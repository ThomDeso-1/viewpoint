-- Google is retired: Outlook / Microsoft 365 is the single mail + calendar
-- provider (Phase 3 of the Outlook sync rebuild).
--
-- The stored OAuth token is the only Google state in the database —
-- everything else was code and `.env` (now removed). Retire
-- GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_CALENDAR_ID /
-- GOOGLE_REDIRECT_URI / EMAIL_PROVIDER from `.env` on upgrade.
--
-- Additive-safe, per the migration 006/007 rule: `appointments.google_event_id`
-- and `exam_requests.gmail_message_id` stay as columns (no longer read); a
-- later FK-safe rebuild can drop them.

DELETE FROM oauth_tokens WHERE provider = 'google';
