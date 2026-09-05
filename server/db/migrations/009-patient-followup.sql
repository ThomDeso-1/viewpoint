-- Patient recall: when is this patient due back for an eye exam?
--
-- The app already mirrors appointments from Outlook but has no recall
-- concept. These columns hold the operator's per-patient follow-up
-- preference and the manual overrides; the "last / current / follow-up"
-- appointment dates themselves are derived from the appointments table at
-- read time, not stored.
--
-- Additive only, on the same reasoning as migrations 006/007/008: the
-- runner wraps every migration in a transaction where PRAGMA
-- legacy_alter_table is a no-op, so a rebuild of `patients` would silently
-- rewrite the foreign keys `appointments`, `exam_requests`, `wave_invoices`,
-- `reminders` and `eligibility_checks` hold against it.

-- off | remind | followup. Defaults to `remind` so patients with exam
-- history surface in the follow-ups list without any per-patient setup;
-- the bounded due window (server/exams/followups.ts) keeps that list short.
ALTER TABLE patients ADD COLUMN followup_mode TEXT NOT NULL DEFAULT 'remind';

-- Operator's explicit follow-up date ('YYYY-MM-DD'), wins over the
-- computed last-exam-plus-interval date. Also where "snooze" writes.
ALTER TABLE patients ADD COLUMN followup_date_override TEXT;

-- When the operator marked the current follow-up cycle handled ("Done").
-- Suppresses the due entry until a newer last-exam appointment appears.
ALTER TABLE patients ADD COLUMN followup_dismissed_at TEXT;

-- When a recall email was last sent to this patient — for display only.
ALTER TABLE patients ADD COLUMN followup_last_emailed_at TEXT;
