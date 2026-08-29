-- The exam-request workflow: patients, their appointments, the OHIP
-- eligibility checks run against them, the Wave invoices raised for them,
-- and the reminders sent to them.
--
-- Note this is the first table in the app holding personal health
-- information. health_card_enc and raw_response_enc are AES-256-GCM blobs
-- (server/services/crypto.ts), never plaintext.

CREATE TABLE IF NOT EXISTS patients (
  id                  TEXT PRIMARY KEY,
  full_name           TEXT NOT NULL,
  email               TEXT,
  phone               TEXT,
  date_of_birth       TEXT,
  health_card_enc     TEXT,
  health_card_version TEXT,
  wave_customer_id    TEXT,
  notes               TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_patients_email ON patients(email);
CREATE INDEX IF NOT EXISTS idx_patients_name  ON patients(full_name);

CREATE TABLE IF NOT EXISTS appointments (
  id              TEXT PRIMARY KEY,
  patient_id      TEXT REFERENCES patients(id) ON DELETE SET NULL,
  -- UNIQUE is the idempotency guarantee for calendar polling: re-reading
  -- the same event can only ever update this row, never duplicate it.
  google_event_id TEXT UNIQUE,
  starts_at       TEXT NOT NULL,
  ends_at         TEXT,
  title           TEXT,
  location        TEXT,
  status          TEXT NOT NULL DEFAULT 'scheduled',
  source          TEXT NOT NULL DEFAULT 'manual',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_appointments_starts  ON appointments(starts_at);
CREATE INDEX IF NOT EXISTS idx_appointments_patient ON appointments(patient_id);

CREATE TABLE IF NOT EXISTS exam_requests (
  id               TEXT PRIMARY KEY,
  -- Same idempotency role as google_event_id above, for Gmail polling.
  gmail_message_id TEXT NOT NULL UNIQUE,
  gmail_thread_id  TEXT,
  received_at      TEXT NOT NULL,
  from_address     TEXT,
  subject          TEXT,
  body_snippet     TEXT,
  extracted_json   TEXT,
  status           TEXT NOT NULL DEFAULT 'received',
  patient_id       TEXT REFERENCES patients(id) ON DELETE SET NULL,
  appointment_id   TEXT REFERENCES appointments(id) ON DELETE SET NULL,
  last_error       TEXT,
  retry_count      INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_exam_requests_status   ON exam_requests(status);
CREATE INDEX IF NOT EXISTS idx_exam_requests_received ON exam_requests(received_at);

CREATE TABLE IF NOT EXISTS eligibility_checks (
  id                   TEXT PRIMARY KEY,
  patient_id           TEXT REFERENCES patients(id) ON DELETE CASCADE,
  appointment_id       TEXT REFERENCES appointments(id) ON DELETE SET NULL,
  checked_at           TEXT NOT NULL,
  date_of_service      TEXT,
  is_eligible          INTEGER,
  response_code        TEXT,
  response_description TEXT,
  raw_response_enc     TEXT,
  error                TEXT,
  -- mock | conformance | production, so a result is never mistaken for
  -- having come from the real ministry service when it did not.
  mode                 TEXT NOT NULL DEFAULT 'mock'
);

CREATE INDEX IF NOT EXISTS idx_eligibility_patient     ON eligibility_checks(patient_id);
CREATE INDEX IF NOT EXISTS idx_eligibility_appointment ON eligibility_checks(appointment_id);

CREATE TABLE IF NOT EXISTS reminders (
  id                  TEXT PRIMARY KEY,
  appointment_id      TEXT NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  channel             TEXT NOT NULL DEFAULT 'email',
  scheduled_for       TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',
  subject             TEXT,
  body                TEXT,
  sent_at             TEXT,
  provider_message_id TEXT,
  last_error          TEXT,
  retry_count         INTEGER NOT NULL DEFAULT 0,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reminders_status    ON reminders(status);
CREATE INDEX IF NOT EXISTS idx_reminders_scheduled ON reminders(scheduled_for);

CREATE TABLE IF NOT EXISTS wave_invoices (
  id               TEXT PRIMARY KEY,
  exam_request_id  TEXT REFERENCES exam_requests(id) ON DELETE SET NULL,
  appointment_id   TEXT REFERENCES appointments(id) ON DELETE SET NULL,
  patient_id       TEXT REFERENCES patients(id) ON DELETE SET NULL,
  wave_invoice_id  TEXT,
  wave_invoice_url TEXT,
  invoice_number   TEXT,
  amount           REAL,
  currency         TEXT NOT NULL DEFAULT 'CAD',
  status           TEXT NOT NULL DEFAULT 'draft',
  last_error       TEXT,
  retry_count      INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wave_invoices_status  ON wave_invoices(status);
CREATE INDEX IF NOT EXISTS idx_wave_invoices_request ON wave_invoices(exam_request_id);

-- One row per connected provider ('google', 'wave'). Both token columns
-- are encrypted blobs, not raw tokens.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  provider          TEXT PRIMARY KEY,
  access_token_enc  TEXT NOT NULL,
  refresh_token_enc TEXT,
  expires_at        TEXT,
  scope             TEXT,
  account_label     TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
