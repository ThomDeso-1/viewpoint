import { getDb } from '../db/db.js';
import type { ProcessedSourceFileRow } from './types.js';
import { applyFailure } from '../platform/failure.js';
import { DEFAULT_MAX_RETRIES } from '../platform/backoff.js';

/**
 * The folder scanner's "already read this" ledger.
 *
 * Keyed by the file's path relative to the configured folder, with its
 * content hash alongside: an unchanged file is skipped forever, an edited
 * one (new hash) is read again. A file that failed to parse is recorded
 * with `status = 'error'` and backs off on retry_count / updated_at, the
 * same way a failed exam-request row does.
 */

export function get(relativePath: string): ProcessedSourceFileRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM processed_source_files WHERE relative_path = ?`)
    .get(relativePath) as ProcessedSourceFileRow | undefined;
}

export function all(): ProcessedSourceFileRow[] {
  return getDb()
    .prepare(`SELECT * FROM processed_source_files ORDER BY processed_at DESC`)
    .all() as ProcessedSourceFileRow[];
}

export function countByStatus(): { ok: number; error: number } {
  const rows = getDb()
    .prepare(`SELECT status, COUNT(*) AS n FROM processed_source_files GROUP BY status`)
    .all() as { status: string; n: number }[];
  const out = { ok: 0, error: 0 };
  for (const r of rows) if (r.status === 'ok' || r.status === 'error') out[r.status] = r.n;
  return out;
}

/** Records a clean read. */
export function markOk(relativePath: string, contentHash: string, patientsFound: number): void {
  const now = new Date().toISOString();
  const existing = get(relativePath);

  getDb()
    .prepare(
      `INSERT INTO processed_source_files
         (relative_path, content_hash, patients_found, status, last_error,
          retry_count, first_seen_at, processed_at, updated_at)
       VALUES (@relative_path, @content_hash, @patients_found, 'ok', NULL, 0,
               @first_seen_at, @processed_at, @updated_at)
       ON CONFLICT(relative_path) DO UPDATE SET
         content_hash = @content_hash, patients_found = @patients_found,
         status = 'ok', last_error = NULL, retry_count = 0,
         processed_at = @processed_at, updated_at = @updated_at`,
    )
    .run({
      relative_path: relativePath,
      content_hash: contentHash,
      patients_found: patientsFound,
      first_seen_at: existing?.first_seen_at ?? now,
      processed_at: now,
      updated_at: now,
    });
}

/** Records a failed read, applying the shared retry/backoff policy. */
export function markError(
  relativePath: string,
  contentHash: string,
  error: string,
  retryable: boolean,
  maxRetries = DEFAULT_MAX_RETRIES,
): void {
  const now = new Date().toISOString();
  const existing = get(relativePath);
  const { retryCount } = applyFailure(
    { retry_count: existing?.status === 'error' ? existing.retry_count : 0 },
    retryable,
    { retrying: 'error', exhausted: 'error', maxRetries, countAlways: true },
  );

  getDb()
    .prepare(
      `INSERT INTO processed_source_files
         (relative_path, content_hash, patients_found, status, last_error,
          retry_count, first_seen_at, processed_at, updated_at)
       VALUES (@relative_path, @content_hash, 0, 'error', @last_error,
               @retry_count, @first_seen_at, @processed_at, @updated_at)
       ON CONFLICT(relative_path) DO UPDATE SET
         content_hash = @content_hash, status = 'error', last_error = @last_error,
         retry_count = @retry_count, processed_at = @processed_at, updated_at = @updated_at`,
    )
    .run({
      relative_path: relativePath,
      content_hash: contentHash,
      last_error: error,
      retry_count: retryCount,
      first_seen_at: existing?.first_seen_at ?? now,
      processed_at: now,
      updated_at: now,
    });
}

/** Forgets a file so the next scan reads it again. */
export function forget(relativePath: string): void {
  getDb().prepare(`DELETE FROM processed_source_files WHERE relative_path = ?`).run(relativePath);
}
