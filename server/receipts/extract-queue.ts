import path from 'path';
import { getDb, type ReceiptRow } from '../db/db.js';
import { extractReceipt, ClaudeAPIError } from '../integrations/claude.js';
import { isReadyForRetry } from '../platform/backoff.js';
import { applyFailure } from '../platform/failure.js';
import { makePoller } from '../platform/poller.js';
import type { StorageService } from './storage.js';

/**
 * Extract queue — reads every newly captured receipt with Claude as soon
 * as it lands, with no operator step in between.
 *
 * Replaces the old Wave upload queue: receipts are now a local tracking
 * system, so the only background work is filling in the fields. Nothing
 * leaves the machine except the image going to Claude.
 *
 *   captured → extracted                (confidence stored alongside)
 *            ↘ needsAttention           (non-retryable, or out of retries)
 *
 * Same shape as the exams queue: backoff is stored on the row
 * (`retry_count` + `updated_at`), not slept, and the loop is `makePoller`.
 * With no CLAUDE_API_KEY the pass is a no-op and rows wait in `captured`
 * until one is added.
 */

const MAX_RETRIES = 5;
const POLL_INTERVAL_MS = 60_000;

/**
 * Read one receipt's image(s) with Claude, store the fields + confidence,
 * and re-file the image under the receipt's own date and vendor.
 *
 * Shared by the queue and the manual "Try again" route. Throws the
 * ClaudeAPIError (or parse error) unchanged — the caller decides whether
 * that is a retry or a 4xx.
 */
export async function extractAndFile(
  storage: StorageService,
  id: string,
  apiKey: string,
): Promise<ReceiptRow> {
  const db = getDb();
  const select = db.prepare(`SELECT * FROM receipts WHERE id = ?`);
  const before = select.get(id) as ReceiptRow | undefined;
  if (!before) throw new Error('Receipt not found.');

  const imagePaths = [before.primary_image, ...parseList(before.additional_images)].map((p) =>
    path.resolve(storage.absolutePath(p)),
  );
  const { result, rawJSON } = await extractReceipt(imagePaths, apiKey);

  // Re-read after the await: the row may have been deleted, or re-filed
  // by a concurrent manual retry, while Claude was working. Everything
  // from here on is synchronous, so it can't interleave with another run.
  const row = select.get(id) as ReceiptRow | undefined;
  if (!row) throw new Error('Receipt not found.');
  // The operator filled it in by hand while Claude was reading — their
  // values win over a late answer.
  if (row.status === 'reviewed' && before.status !== 'reviewed') return row;

  const ymd = result.receipt_date;
  const primary = storage.refileReceipt(row.primary_image, ymd, result.vendor);
  const additional = parseList(row.additional_images).map((p) =>
    storage.refileReceipt(p, ymd, result.vendor),
  );
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE receipts SET
      vendor = @vendor,
      summary = @summary,
      total_amount = @total_amount,
      tax_amount = @tax_amount,
      currency = @currency,
      extracted_json = @extracted_json,
      confidence = @confidence,
      receipt_date = @receipt_date,
      month_folder = @month_folder,
      primary_image = @primary_image,
      additional_images = @additional_images,
      status = 'extracted',
      last_error = NULL,
      retry_count = 0,
      updated_at = @updated_at
    WHERE id = @id
  `).run({
    id,
    vendor: result.vendor,
    summary: result.summary_description,
    total_amount: result.total,
    tax_amount: result.taxes.reduce((sum, t) => sum + t.amount, 0),
    currency: result.currency,
    extracted_json: rawJSON,
    confidence: result.confidence,
    receipt_date: ymd + 'T00:00:00.000Z',
    month_folder: ymd.slice(0, 7),
    primary_image: primary,
    additional_images: JSON.stringify(additional),
    updated_at: now,
  });

  storage.saveSidecar(primary, {
    status: 'extracted',
    capturedAt: row.capture_date,
    extractedAt: now,
    extraction: result,
  });

  return select.get(id) as ReceiptRow;
}

// ── Process Queue ──

export async function processQueue(storage: StorageService): Promise<void> {
  const apiKey = process.env.CLAUDE_API_KEY;
  if (!apiKey) return; // rows wait in `captured` until a key is added

  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM receipts WHERE status = 'captured' ORDER BY created_at ASC`)
    .all() as ReceiptRow[];
  const now = Date.now();

  for (const row of rows) {
    // One flaky receipt backs off on its own schedule; the rest of the
    // batch doesn't wait on it.
    if (!isReadyForRetry(row, now)) continue;

    try {
      await extractAndFile(storage, row.id, apiKey);
    } catch (err) {
      // Rate limits / 5xx / network are worth another go. A malformed
      // response or a 4xx won't get better by retrying the same image.
      const retryable = err instanceof ClaudeAPIError && err.isRetryable;
      const { status, retryCount } = applyFailure(row, retryable, {
        retrying: 'captured',
        exhausted: 'needsAttention',
        maxRetries: MAX_RETRIES,
      });
      db.prepare(
        `UPDATE receipts SET status = ?, last_error = ?, retry_count = ?, updated_at = ? WHERE id = ?`,
      ).run(status, (err as Error).message, retryCount, new Date().toISOString(), row.id);
    }
  }
}

// The poller needs the app's StorageService, which only exists once
// createApp() has run — so it is handed over at start(). Until then (and
// always in tests, which never start pollers) a trigger is a no-op.
let storageRef: StorageService | null = null;

const poller = makePoller({
  name: 'extract-queue',
  intervalMs: POLL_INTERVAL_MS,
  pass: async () => {
    if (storageRef) await processQueue(storageRef);
  },
});

/** Run a pass now (after an upload), fire-and-forget. */
export const triggerQueue = poller.trigger;

export function startPolling(storage: StorageService): void {
  storageRef = storage;
  poller.start();
}

export const stopPolling = poller.stop;

function parseList(json: string | null): string[] {
  try {
    const v = JSON.parse(json || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
