-- "Patients" become "clients": one directory for everyone the business
-- deals with, filterable by kind. Driven by the one-time Wave customer
-- import (server/exams/wave-import.ts) — Wave's customer list holds
-- eyewear customers and companies as well as exam patients.
--
-- The table keeps its name. Renaming or rebuilding `patients` would
-- rewrite the foreign keys `appointments`, `exam_requests`,
-- `wave_invoices`, `reminders` and `eligibility_checks` hold against it
-- (see the note in 009). Additive only, like 006–010.

-- patient | customer | business. Every existing row came from an exam
-- file, so they are all patients. A Wave import creates `customer` (or
-- `business` for a company-looking name); an exam file naming a customer
-- promotes them to `patient` (server/exams/queue.ts).
ALTER TABLE patients ADD COLUMN client_type TEXT NOT NULL DEFAULT 'patient';

-- One formatted postal address, as Wave holds it. Plaintext like
-- email/phone; only the health card number is encrypted.
ALTER TABLE patients ADD COLUMN address TEXT;

-- Set when an import created this record although another client already
-- had the same name (but no matching email) — a *possible* duplicate for
-- the operator to confirm. Holds the other record's id; cleared by
-- "Not a duplicate". No FK: it's a hint, and patients are soft-deleted.
ALTER TABLE patients ADD COLUMN possible_duplicate_of TEXT;

CREATE INDEX IF NOT EXISTS idx_patients_wave_customer ON patients(wave_customer_id);
CREATE INDEX IF NOT EXISTS idx_patients_client_type ON patients(client_type);
