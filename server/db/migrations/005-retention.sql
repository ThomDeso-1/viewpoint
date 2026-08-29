-- Retention + audit integrity (AUDIT P1-4).
--
-- 1. Eligibility history must survive deleting the patient it belongs to.
--    The 003 schema had ON DELETE CASCADE, so a patient delete erased
--    every OHIP check run against them — the opposite of what PHIPA
--    expects. SQLite can't alter a foreign key in place, so the table is
--    rebuilt with ON DELETE SET NULL. eligibility_checks is a leaf (no
--    inbound FKs), so this is safe with foreign_keys on.
CREATE TABLE eligibility_checks_new (
  id                   TEXT PRIMARY KEY,
  patient_id           TEXT REFERENCES patients(id) ON DELETE SET NULL,
  appointment_id       TEXT REFERENCES appointments(id) ON DELETE SET NULL,
  checked_at           TEXT NOT NULL,
  date_of_service      TEXT,
  is_eligible          INTEGER,
  response_code        TEXT,
  response_description TEXT,
  raw_response_enc     TEXT,
  error                TEXT,
  mode                 TEXT NOT NULL DEFAULT 'mock'
);

INSERT INTO eligibility_checks_new
  (id, patient_id, appointment_id, checked_at, date_of_service, is_eligible,
   response_code, response_description, raw_response_enc, error, mode)
SELECT
  id, patient_id, appointment_id, checked_at, date_of_service, is_eligible,
  response_code, response_description, raw_response_enc, error, mode
FROM eligibility_checks;

DROP TABLE eligibility_checks;
ALTER TABLE eligibility_checks_new RENAME TO eligibility_checks;

CREATE INDEX IF NOT EXISTS idx_eligibility_patient     ON eligibility_checks(patient_id);
CREATE INDEX IF NOT EXISTS idx_eligibility_appointment ON eligibility_checks(appointment_id);

-- 2. Soft-delete patients. A hard DELETE also loses the link from an
--    appointment / invoice / check to who it was for. deletePatient()
--    now stamps deleted_at; every read filters deleted_at IS NULL.
ALTER TABLE patients ADD COLUMN deleted_at TEXT;

-- 3. Tamper-evident audit_log. Each row carries the hash of the previous
--    row chained into its own, so an edit or a deletion breaks the
--    chain and verifyAuditChain() can detect it. Existing rows predate
--    the chain and stay NULL (the chain starts from the first new row).
ALTER TABLE audit_log ADD COLUMN prev_hash  TEXT;
ALTER TABLE audit_log ADD COLUMN entry_hash TEXT;
