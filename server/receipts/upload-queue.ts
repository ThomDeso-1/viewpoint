import { getDb, type ReceiptRow } from '../db/db.js';
import { createExpenseTransaction, WaveAPIError } from '../integrations/wave/index.js';
import { getWaveToken, isWaveConfigured } from '../integrations/wave/auth.js';
import { isReadyForRetry } from '../platform/backoff.js';

/**
 * Upload Queue — server-side port of UploadService.swift
 *
 * Processes reviewed receipts by creating expense transactions in Wave.
 * Runs with exponential backoff on failure (base 5s, max 300s, max 5 retries).
 *
 * Improvement over iOS: runs 24/7 on the server instead of only during
 * app foreground/background refresh windows.
 */

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 5_000;
const MAX_DELAY_MS = 300_000;
const POLL_INTERVAL_MS = 60_000; // check every minute

let running = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;

// ── Prepared statements (lazy) ──

function getStatements() {
  const db = getDb();
  return {
    selectReviewed: db.prepare(
      `SELECT * FROM receipts WHERE status = 'reviewed' ORDER BY receipt_date ASC`,
    ),
    updateStatus: db.prepare(`
      UPDATE receipts SET
        status = @status,
        wave_txn_id = @wave_txn_id,
        last_error = @last_error,
        retry_count = @retry_count,
        updated_at = @updated_at
      WHERE id = @id
    `),
  };
}

// ── Process Queue ──

export async function processQueue(): Promise<void> {
  if (running) return;
  running = true;

  try {
    const businessId = process.env.WAVE_BUSINESS_ID;
    const expenseAccountId = process.env.WAVE_EXPENSE_ACCOUNT_ID;
    const anchorAccountId = process.env.WAVE_ANCHOR_ACCOUNT_ID;
    const salesTaxId = process.env.WAVE_SALES_TAX_ID || undefined;

    if (!isWaveConfigured() || !businessId || !expenseAccountId || !anchorAccountId) {
      return; // Wave not configured — nothing to do
    }

    // Resolved once per pass rather than per receipt: in OAuth mode this
    // may refresh, and a whole batch should not trigger a refresh each.
    let token: string;
    try {
      token = await getWaveToken();
    } catch (err) {
      console.error('[upload-queue] could not obtain a Wave token:', (err as Error).message);
      return;
    }

    const stmts = getStatements();
    const receipts = stmts.selectReviewed.all() as ReceiptRow[];
    const now = Date.now();

    for (const receipt of receipts) {
      // A receipt that already failed once backs off before its next
      // attempt (exponential, base 5s, capped at 300s). Skip it for this
      // run rather than blocking the whole batch on a per-item sleep —
      // other reviewed receipts shouldn't wait on one flaky retry, and
      // this receipt will be picked up again on a later poll.
      if (!isReadyForRetry(receipt, now, { baseDelayMs: BASE_DELAY_MS, maxDelayMs: MAX_DELAY_MS })) {
        continue;
      }

      const amount = receipt.total_amount ?? 0;

      if (amount <= 0) {
        stmts.updateStatus.run({
          id: receipt.id,
          status: 'needsAttention',
          wave_txn_id: null,
          last_error: 'Total amount is zero or missing.',
          retry_count: receipt.retry_count,
          updated_at: new Date().toISOString(),
        });
        continue;
      }

      const description = buildDescription(receipt);
      const dateStr = receipt.receipt_date.slice(0, 10); // "YYYY-MM-DD"

      try {
        const result = await createExpenseTransaction({
          businessId,
          receiptId: receipt.id,
          date: dateStr,
          description,
          amount,
          expenseAccountId,
          anchorAccountId,
          salesTaxId,
          token,
        });

        if (result.didSucceed) {
          stmts.updateStatus.run({
            id: receipt.id,
            status: 'uploaded',
            wave_txn_id: result.transactionId,
            last_error: null,
            retry_count: 0,
            updated_at: new Date().toISOString(),
          });
        } else {
          const reason = result.errors.join('; ');
          stmts.updateStatus.run({
            id: receipt.id,
            status: 'needsAttention',
            wave_txn_id: null,
            last_error: reason,
            retry_count: receipt.retry_count,
            updated_at: new Date().toISOString(),
          });
        }
      } catch (err) {
        const newRetry = receipt.retry_count + 1;
        const isRetryable = err instanceof WaveAPIError && err.isRetryable;
        const newStatus =
          !isRetryable || newRetry >= MAX_RETRIES ? 'failed' : 'reviewed';

        stmts.updateStatus.run({
          id: receipt.id,
          status: newStatus,
          wave_txn_id: null,
          last_error: (err as Error).message,
          retry_count: newRetry,
          updated_at: new Date().toISOString(),
        });
      }
    }
  } finally {
    running = false;
  }
}

/**
 * Fire off a queue pass without waiting for it. Per-receipt failures
 * (Wave rejections, transport errors) are already recorded on the
 * receipt itself inside processQueue() — this only catches something
 * going wrong before/around that, e.g. a DB error, which would otherwise
 * vanish silently.
 */
export function triggerQueue(): void {
  processQueue().catch((err) => {
    console.error('[upload-queue] processQueue failed:', err);
  });
}

// ── Retry helpers ──

export function retryReceipt(id: string): void {
  const db = getDb();
  db.prepare(
    `UPDATE receipts SET status = 'reviewed', retry_count = 0, last_error = NULL, updated_at = ? WHERE id = ?`,
  ).run(new Date().toISOString(), id);

  triggerQueue();
}

export function retryAll(): void {
  const db = getDb();
  db.prepare(
    `UPDATE receipts SET status = 'reviewed', retry_count = 0, last_error = NULL, updated_at = ?
     WHERE status IN ('failed', 'needsAttention')`,
  ).run(new Date().toISOString());

  triggerQueue();
}

// ── Background polling ──

export function startPolling(): void {
  if (pollTimer) return;
  pollTimer = setInterval(triggerQueue, POLL_INTERVAL_MS);

  // Also run immediately on start
  triggerQueue();
}

export function stopPolling(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ── Helpers ──

function buildDescription(receipt: ReceiptRow): string {
  const parts: string[] = [];
  if (receipt.vendor) parts.push(receipt.vendor);
  if (receipt.summary) parts.push(receipt.summary);
  return parts.length > 0 ? parts.join(' — ') : 'Expense';
}
