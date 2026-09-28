-- Receipts become a local tracking system, not a Wave expense feed.
--
-- The Wave upload queue is gone: a photo is read by Claude as soon as it
-- lands (server/receipts/extract-queue.ts) and the fields are filled in
-- with a confidence rating. There is no approval gate — `reviewed` now
-- just means "the operator has checked / corrected this one".
--
-- New status machine:
--   captured → extracted → reviewed
--            ↘ needsAttention   (Claude couldn't read it after retries)
--
-- Additive only, like 006–009. `wave_txn_id` stays so receipts that did
-- reach Wave keep that reference.

-- Claude's "high" | "medium" | "low" for the extraction; NULL until read.
-- Copied out of extracted_json so the list can show and filter on it
-- without parsing every blob.
ALTER TABLE receipts ADD COLUMN confidence TEXT;

UPDATE receipts
   SET confidence = json_extract(extracted_json, '$.confidence')
 WHERE extracted_json IS NOT NULL AND json_valid(extracted_json);

-- Every receipt that got as far as the old upload queue had been approved
-- by the operator, so all of them are "checked" in the new model. The
-- old `needsAttention` / `failed` meant a *Wave* problem, not an
-- unreadable image — clear those errors rather than leave them looking
-- like extraction failures.
UPDATE receipts
   SET status = 'reviewed', last_error = NULL, retry_count = 0
 WHERE status IN ('uploaded', 'failed', 'needsAttention');

CREATE INDEX IF NOT EXISTS idx_receipts_date ON receipts(receipt_date);
