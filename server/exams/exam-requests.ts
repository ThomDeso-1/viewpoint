import { v4 as uuid } from 'uuid';
import { getDb } from '../db/db.js';
import type { ExamRequestRow, ExamRequestStatus, ExamRequestExtraction } from './types.js';
import { encrypt, decrypt } from '../platform/crypto.js';
import { applyFailure } from '../platform/failure.js';
import { DEFAULT_MAX_RETRIES } from '../platform/backoff.js';

/**
 * Exam requests — one row per patient found in a scanned file.
 *
 * This is the spine of the automation queue: each row carries a request
 * from "a file was read" through extraction, patient matching,
 * eligibility, and a drafted invoice, up to the single point where the
 * operator approves it. (Legacy rows sourced from Gmail sit in the same
 * table with `source = 'gmail'`.)
 */

export function getExamRequest(id: string): ExamRequestRow | undefined {
  return getDb().prepare(`SELECT * FROM exam_requests WHERE id = ?`).get(id) as
    | ExamRequestRow
    | undefined;
}

export function findBySourceRef(sourceRef: string): ExamRequestRow | undefined {
  return getDb().prepare(`SELECT * FROM exam_requests WHERE source_ref = ?`).get(sourceRef) as
    | ExamRequestRow
    | undefined;
}

export function listByStatus(status: ExamRequestStatus): ExamRequestRow[] {
  return getDb()
    .prepare(`SELECT * FROM exam_requests WHERE status = ? ORDER BY received_at ASC`)
    .all(status) as ExamRequestRow[];
}

export function listAll(limit = 200): ExamRequestRow[] {
  return getDb()
    .prepare(`SELECT * FROM exam_requests ORDER BY received_at DESC, rowid DESC LIMIT ?`)
    .all(limit) as ExamRequestRow[];
}

/** Everything waiting on the operator, newest first. */
export function listPending(): ExamRequestRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM exam_requests
       WHERE status IN ('received', 'extracted', 'drafted', 'needsAttention', 'failed')
       ORDER BY received_at DESC, rowid DESC`,
    )
    .all() as ExamRequestRow[];
}

export interface SourceRecordInput {
  /** Stable idempotency key — `<file-content-hash>#<patient-index>`. */
  sourceRef: string;
  /** Card header text, e.g. `sept-bookings.xlsx — patient 3`. */
  sourceLabel: string;
  /** ISO timestamp — the file's modified time. */
  receivedAt: string;
  /** The slice of the file this patient was read from. */
  rawText: string;
  /** Claude's extraction for this one patient, already validated. */
  extractionJson: string;
}

/**
 * Inserts one patient found in a scanned file, or returns the existing row.
 *
 * `source_ref` is UNIQUE (migration 006), so re-scanning a file that
 * hasn't changed can only ever find the existing rows. Extraction has
 * already run by the time the scanner calls this — one Claude request per
 * file, not per patient — so the row lands straight in `extracted`.
 */
export function createFromSourceRecord(input: SourceRecordInput): {
  row: ExamRequestRow;
  isNew: boolean;
} {
  const existing = findBySourceRef(input.sourceRef);
  if (existing) return { row: existing, isNew: false };

  const now = new Date().toISOString();
  const id = uuid();

  getDb()
    .prepare(
      `INSERT INTO exam_requests (
         id, source, source_ref, source_label, gmail_message_id, received_at,
         body_snippet, extracted_json, status, retry_count, created_at, updated_at
       ) VALUES (
         @id, 'file', @source_ref, @source_label, @source_ref, @received_at,
         @body_snippet, @extracted_json, 'extracted', 0, @created_at, @updated_at
       )`,
    )
    .run({
      id,
      source_ref: input.sourceRef,
      source_label: input.sourceLabel,
      received_at: input.receivedAt,
      // Encrypted, like extracted_json: a patient row in a booking file
      // routinely spells out the health card number, DOB and name, so a
      // plaintext copy here would defeat the encryption in `patients`.
      // Read it back through readBodySnippet().
      body_snippet: encrypt(input.rawText.slice(0, 2000)),
      extracted_json: encrypt(input.extractionJson),
      created_at: now,
      updated_at: now,
    });

  return { row: getExamRequest(id)!, isNew: true };
}

export function readExtraction(row: ExamRequestRow): ExamRequestExtraction | null {
  if (!row.extracted_json) return null;
  try {
    const json = row.extracted_json.startsWith('v1:')
      ? decrypt(row.extracted_json)
      : row.extracted_json; // tolerate a row written before encryption landed
    return JSON.parse(json) as ExamRequestExtraction;
  } catch {
    // An unreadable blob is a data problem, not a crash — the queue
    // treats the row as "not yet extracted" and tries again.
    return null;
  }
}

/**
 * Decrypts the retained slice of the original email.
 *
 * This is PHI (name, DOB, often a health card number), so it is never put
 * in the exam-request DTO — it is reached only through the audited
 * `GET /exam-requests/:id/source` route.
 */
export function readBodySnippet(row: ExamRequestRow): string | null {
  if (!row.body_snippet) return null;
  try {
    return row.body_snippet.startsWith('v1:')
      ? decrypt(row.body_snippet)
      : row.body_snippet; // tolerate a row written before encryption landed
  } catch {
    return null;
  }
}

/**
 * The extraction as the API should expose it: the health card number is
 * masked, matching how patient records are serialised.
 */
export function toExtractionDto(
  extraction: ExamRequestExtraction | null,
): (Omit<ExamRequestExtraction, 'health_card_number'> & { health_card_masked: string | null }) | null {
  if (!extraction) return null;

  const { health_card_number, ...rest } = extraction;
  return {
    ...rest,
    health_card_masked: health_card_number ? `•••• ••${health_card_number.slice(-4)}` : null,
  };
}

export function setStatus(id: string, status: ExamRequestStatus): void {
  getDb()
    .prepare(`UPDATE exam_requests SET status = ?, updated_at = ? WHERE id = ?`)
    .run(status, new Date().toISOString(), id);
}

export function linkPatient(id: string, patientId: string): void {
  getDb()
    .prepare(`UPDATE exam_requests SET patient_id = ?, updated_at = ? WHERE id = ?`)
    .run(patientId, new Date().toISOString(), id);
}

export function linkAppointment(id: string, appointmentId: string): void {
  getDb()
    .prepare(`UPDATE exam_requests SET appointment_id = ?, updated_at = ? WHERE id = ?`)
    .run(appointmentId, new Date().toISOString(), id);
}

/**
 * Records a failure.
 *
 * `retryable` decides whether this counts against the retry budget and
 * stays in the queue, or stops immediately as needsAttention. Mirrors the
 * distinction the receipt queue draws between a transport blip and a
 * rejection that will never succeed.
 */
export function recordFailure(
  id: string,
  error: string,
  retryable: boolean,
  maxRetries = DEFAULT_MAX_RETRIES,
): void {
  const row = getExamRequest(id);
  if (!row) return;

  // A non-retryable failure parks the request for the operator
  // (`needsAttention`) rather than marking it dead — see the receipt
  // queue for the `failed` variant.
  const { status, retryCount } = applyFailure<ExamRequestStatus>(row, retryable, {
    retrying: row.status,
    exhausted: 'failed',
    terminal: 'needsAttention',
    maxRetries,
  });

  getDb()
    .prepare(
      `UPDATE exam_requests SET status = ?, last_error = ?, retry_count = ?, updated_at = ? WHERE id = ?`,
    )
    .run(status, error, retryCount, new Date().toISOString(), id);
}

/** Clears the error state so the queue picks the row up again. */
export function retryExamRequest(id: string): void {
  const row = getExamRequest(id);
  if (!row) return;

  // Rewind to the furthest stage that is known-good, so the queue redoes
  // only the part that failed. An already-approved request whose commit
  // failed stays approved — retryApproved() re-attempts just that.
  const status: ExamRequestStatus =
    row.status === 'approved' ? 'approved' : row.extracted_json ? 'extracted' : 'received';

  getDb()
    .prepare(
      `UPDATE exam_requests SET status = ?, last_error = NULL, retry_count = 0, updated_at = ? WHERE id = ?`,
    )
    .run(status, new Date().toISOString(), id);
}

export function deleteExamRequest(id: string): boolean {
  return getDb().prepare(`DELETE FROM exam_requests WHERE id = ?`).run(id).changes > 0;
}

/** Counts by status, for the header badge on the Inbox screen. */
export function statusCounts(): Record<string, number> {
  const rows = getDb()
    .prepare(`SELECT status, COUNT(*) as count FROM exam_requests GROUP BY status`)
    .all() as { status: string; count: number }[];

  return Object.fromEntries(rows.map((r) => [r.status, r.count]));
}
