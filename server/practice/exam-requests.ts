import { v4 as uuid } from 'uuid';
import { getDb } from '../db/db.js';
import type { ExamRequestRow, ExamRequestStatus, ExamRequestExtraction } from './types.js';
import type { GmailMessage } from '../integrations/google/gmail.js';
import { encrypt, decrypt } from '../platform/crypto.js';

/**
 * Exam requests — one row per incoming email that looks like a booking.
 *
 * This is the spine of the automation queue: each row carries a request
 * from "an email arrived" through extraction, patient matching,
 * eligibility, and a drafted invoice, up to the single point where the
 * operator approves it.
 */

export function getExamRequest(id: string): ExamRequestRow | undefined {
  return getDb().prepare(`SELECT * FROM exam_requests WHERE id = ?`).get(id) as
    | ExamRequestRow
    | undefined;
}

export function findByGmailMessageId(messageId: string): ExamRequestRow | undefined {
  return getDb().prepare(`SELECT * FROM exam_requests WHERE gmail_message_id = ?`).get(messageId) as
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

/**
 * Inserts a request for a Gmail message, or returns the existing one.
 *
 * gmail_message_id is UNIQUE, so re-polling an overlapping time window
 * cannot create duplicates — which matters because the poll window
 * deliberately overlaps to avoid missing anything at the boundary.
 */
export function createFromGmailMessage(message: GmailMessage): {
  row: ExamRequestRow;
  isNew: boolean;
} {
  const existing = findByGmailMessageId(message.id);
  if (existing) return { row: existing, isNew: false };

  const now = new Date().toISOString();
  const id = uuid();

  getDb()
    .prepare(
      `INSERT INTO exam_requests (
         id, gmail_message_id, gmail_thread_id, received_at, from_address,
         subject, body_snippet, status, retry_count, created_at, updated_at
       ) VALUES (
         @id, @gmail_message_id, @gmail_thread_id, @received_at, @from_address,
         @subject, @body_snippet, 'received', 0, @created_at, @updated_at
       )`,
    )
    .run({
      id,
      gmail_message_id: message.id,
      gmail_thread_id: message.threadId,
      received_at: message.receivedAt,
      from_address: message.from,
      subject: message.subject,
      // Only a snippet is retained: the full message stays in Gmail, and
      // this table is already holding enough personal information.
      //
      // Encrypted, like extracted_json: a booking email routinely spells
      // out the health card number, DOB and name in its body, so a
      // plaintext copy here would defeat the encryption in `patients`.
      // Read it back through readBodySnippet().
      body_snippet: encrypt((message.body || message.snippet).slice(0, 2000)),
      created_at: now,
      updated_at: now,
    });

  return { row: getExamRequest(id)!, isNew: true };
}

/**
 * Stores Claude's extraction, encrypted.
 *
 * The blob carries a name, date of birth, contact details and often a
 * health card number — the same personal health information the patients
 * table encrypts. Storing it as plaintext here would have left a second,
 * unprotected copy of every card number in the database.
 */
export function saveExtraction(id: string, rawJson: string): void {
  getDb()
    .prepare(
      `UPDATE exam_requests SET
         extracted_json = ?, status = 'extracted', last_error = NULL,
         retry_count = 0, updated_at = ?
       WHERE id = ?`,
    )
    .run(encrypt(rawJson), new Date().toISOString(), id);
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
export function recordFailure(id: string, error: string, retryable: boolean, maxRetries = 5): void {
  const row = getExamRequest(id);
  if (!row) return;

  const retryCount = retryable ? row.retry_count + 1 : row.retry_count;
  const status: ExamRequestStatus = !retryable
    ? 'needsAttention'
    : retryCount >= maxRetries
      ? 'failed'
      : row.status;

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
  // only the part that failed.
  const status: ExamRequestStatus = row.extracted_json ? 'extracted' : 'received';

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
