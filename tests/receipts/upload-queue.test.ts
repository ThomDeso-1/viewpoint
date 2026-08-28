import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import type { Database as DatabaseType } from 'better-sqlite3';
import { WaveAPIError } from '../../server/integrations/wave/wave.js';

/**
 * Spec (CONVERSION-PLAN.md "Receipt Pipeline" + "Upload Queue"):
 *   reviewed --success--> uploaded
 *   reviewed --Wave rejects (didSucceed:false)--> needsAttention
 *   reviewed --zero/missing total--> needsAttention
 *   reviewed --retryable error, retries remain--> reviewed (retry_count++, backoff)
 *   reviewed --retryable error, retries exhausted--> failed
 *   reviewed --non-retryable error--> failed
 * retryReceipt / retryAll reset a receipt to 'reviewed' with retry_count=0
 * and re-trigger the queue. The description sent to Wave is
 * "vendor — summary", falling back to whichever part is present, or
 * "Expense" if neither is set.
 */
vi.mock('../../server/integrations/wave/wave.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/integrations/wave/wave.js')>();
  return { ...actual, createExpenseTransaction: vi.fn() };
});

async function setupQueue(envOverrides: Record<string, string | undefined> = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-queue-test-'));
  process.env.DATA_DIR = dataDir;
  const base: Record<string, string | undefined> = {
    WAVE_ACCESS_TOKEN: 'wave-token',
    WAVE_BUSINESS_ID: 'biz-1',
    WAVE_EXPENSE_ACCOUNT_ID: 'exp-1',
    WAVE_ANCHOR_ACCOUNT_ID: 'anchor-1',
    WAVE_SALES_TAX_ID: undefined,
    ...envOverrides,
  };
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  vi.resetModules();
  const dbModule = await import('../../server/db/db.js');
  const waveModule = await import('../../server/integrations/wave/wave.js');
  const queueModule = await import('../../server/receipts/upload-queue.js');

  return {
    db: dbModule.getDb(),
    createExpenseTransaction: waveModule.createExpenseTransaction as unknown as ReturnType<typeof vi.fn>,
    queue: queueModule,
    dataDir,
  };
}

function insertReceipt(db: DatabaseType, overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  const row = {
    id: crypto.randomUUID(),
    primary_image: '2026-01/x.jpg',
    additional_images: '[]',
    receipt_date: '2026-01-01T00:00:00.000Z',
    capture_date: now,
    month_folder: '2026-01',
    status: 'reviewed',
    vendor: 'Test Vendor',
    summary: 'stuff',
    total_amount: 25.5,
    tax_amount: 2.5,
    currency: 'CAD',
    extracted_json: null,
    wave_txn_id: null,
    last_error: null,
    retry_count: 0,
    image_hash: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO receipts (id, primary_image, additional_images, receipt_date, capture_date, month_folder,
       status, vendor, summary, total_amount, tax_amount, currency, extracted_json, wave_txn_id, last_error,
       retry_count, image_hash, created_at, updated_at)
     VALUES (@id, @primary_image, @additional_images, @receipt_date, @capture_date, @month_folder,
       @status, @vendor, @summary, @total_amount, @tax_amount, @currency, @extracted_json, @wave_txn_id,
       @last_error, @retry_count, @image_hash, @created_at, @updated_at)`,
  ).run(row as any);
  return row;
}

function getRow(db: DatabaseType, id: string): any {
  return db.prepare('SELECT * FROM receipts WHERE id = ?').get(id);
}

let ctx: Awaited<ReturnType<typeof setupQueue>>;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  // vi.mock's factory-created mock is shared across this whole file even
  // through vi.resetModules(), so its call history/queued implementations
  // must be cleared explicitly between tests.
  ctx?.createExpenseTransaction?.mockReset();
  if (ctx) fs.rmSync(ctx.dataDir, { recursive: true, force: true });
  delete process.env.WAVE_ACCESS_TOKEN;
  delete process.env.WAVE_BUSINESS_ID;
  delete process.env.WAVE_EXPENSE_ACCOUNT_ID;
  delete process.env.WAVE_ANCHOR_ACCOUNT_ID;
  delete process.env.WAVE_SALES_TAX_ID;
});

describe('processQueue', () => {
  it('does nothing when Wave is not fully configured', async () => {
    ctx = await setupQueue({ WAVE_EXPENSE_ACCOUNT_ID: undefined });
    const receipt = insertReceipt(ctx.db);

    await ctx.queue.processQueue();

    expect(ctx.createExpenseTransaction).not.toHaveBeenCalled();
    expect(getRow(ctx.db, receipt.id).status).toBe('reviewed');
  });

  it('marks a zero-amount receipt needsAttention without calling Wave', async () => {
    ctx = await setupQueue();
    const receipt = insertReceipt(ctx.db, { total_amount: 0 });

    await ctx.queue.processQueue();

    expect(ctx.createExpenseTransaction).not.toHaveBeenCalled();
    const row = getRow(ctx.db, receipt.id);
    expect(row.status).toBe('needsAttention');
    expect(row.last_error).toMatch(/zero or missing/i);
  });

  it('marks a missing-total (null) receipt needsAttention', async () => {
    ctx = await setupQueue();
    const receipt = insertReceipt(ctx.db, { total_amount: null });

    await ctx.queue.processQueue();

    expect(getRow(ctx.db, receipt.id).status).toBe('needsAttention');
  });

  it('on success: stores the Wave transaction id and status=uploaded', async () => {
    ctx = await setupQueue();
    // updated_at is backdated past the retry_count=2 backoff window (10s),
    // as it would be in practice if the prior failure happened a while ago.
    const receipt = insertReceipt(ctx.db, {
      retry_count: 2,
      updated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    ctx.createExpenseTransaction.mockResolvedValueOnce({
      didSucceed: true,
      transactionId: 'wave-txn-abc',
      errors: [],
    });

    await ctx.queue.processQueue();

    const row = getRow(ctx.db, receipt.id);
    expect(row.status).toBe('uploaded');
    expect(row.wave_txn_id).toBe('wave-txn-abc');
    expect(row.retry_count).toBe(0);
    expect(row.last_error).toBeNull();
  });

  it('when Wave rejects the transaction (business rule), status becomes needsAttention with the reason', async () => {
    ctx = await setupQueue();
    const receipt = insertReceipt(ctx.db);
    ctx.createExpenseTransaction.mockResolvedValueOnce({
      didSucceed: false,
      transactionId: null,
      errors: ['anchor.amount: Amount must be greater than zero'],
    });

    await ctx.queue.processQueue();

    const row = getRow(ctx.db, receipt.id);
    expect(row.status).toBe('needsAttention');
    expect(row.last_error).toContain('Amount must be greater than zero');
    expect(row.wave_txn_id).toBeNull();
  });

  it('on a retryable transport error with retries remaining, stays reviewed and increments retry_count', async () => {
    ctx = await setupQueue();
    const receipt = insertReceipt(ctx.db, { retry_count: 0 });
    ctx.createExpenseTransaction.mockRejectedValueOnce(new WaveAPIError('network_error', 'connection reset'));

    await ctx.queue.processQueue();

    const row = getRow(ctx.db, receipt.id);
    expect(row.status).toBe('reviewed');
    expect(row.retry_count).toBe(1);
    expect(row.last_error).toBe('connection reset');
  });

  it('does not block other receipts in the same run behind one that just failed', async () => {
    ctx = await setupQueue();
    // Earlier date so it's attempted first and fails.
    const flaky = insertReceipt(ctx.db, {
      vendor: 'Flaky',
      receipt_date: '2026-01-01T00:00:00.000Z',
      retry_count: 0,
    });
    const healthy = insertReceipt(ctx.db, {
      vendor: 'Healthy',
      receipt_date: '2026-02-01T00:00:00.000Z',
    });
    ctx.createExpenseTransaction
      .mockRejectedValueOnce(new WaveAPIError('network_error', 'connection reset'))
      .mockResolvedValueOnce({ didSucceed: true, transactionId: 'txn-healthy', errors: [] });

    // No fake timers involved: both receipts should be attempted within
    // the same processQueue() call with no waiting in between.
    await ctx.queue.processQueue();

    expect(ctx.createExpenseTransaction).toHaveBeenCalledTimes(2);
    expect(getRow(ctx.db, flaky.id).status).toBe('reviewed');
    expect(getRow(ctx.db, healthy.id).status).toBe('uploaded');
  });

  it('skips a receipt still inside its backoff window, and retries it once the window elapses', async () => {
    ctx = await setupQueue();
    const recentlyFailed = insertReceipt(ctx.db, {
      retry_count: 1, // backoff = 5s
      updated_at: new Date().toISOString(),
    });

    await ctx.queue.processQueue();

    expect(ctx.createExpenseTransaction).not.toHaveBeenCalled();
    expect(getRow(ctx.db, recentlyFailed.id).status).toBe('reviewed');

    // Backoff window has elapsed — next run should attempt it.
    ctx.db
      .prepare(`UPDATE receipts SET updated_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 6_000).toISOString(), recentlyFailed.id);
    ctx.createExpenseTransaction.mockResolvedValueOnce({ didSucceed: true, transactionId: 't', errors: [] });

    await ctx.queue.processQueue();

    expect(ctx.createExpenseTransaction).toHaveBeenCalledTimes(1);
    expect(getRow(ctx.db, recentlyFailed.id).status).toBe('uploaded');
  });

  it('on a non-retryable transport error (e.g. invalid token), fails immediately without waiting', async () => {
    ctx = await setupQueue();
    const receipt = insertReceipt(ctx.db, { retry_count: 0 });
    ctx.createExpenseTransaction.mockRejectedValueOnce(new WaveAPIError('invalid_token', 'token is bad'));

    await ctx.queue.processQueue();

    const row = getRow(ctx.db, receipt.id);
    expect(row.status).toBe('failed');
    expect(row.retry_count).toBe(1);
  });

  it('marks failed once a retryable error exhausts the retry budget', async () => {
    ctx = await setupQueue();
    // Already at the last allowed retry (MAX_RETRIES = 5), backdated past
    // its backoff window (40s) so this run actually attempts it.
    const receipt = insertReceipt(ctx.db, {
      retry_count: 4,
      updated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    ctx.createExpenseTransaction.mockRejectedValueOnce(new WaveAPIError('server_error', 'still down'));

    await ctx.queue.processQueue();

    const row = getRow(ctx.db, receipt.id);
    expect(row.status).toBe('failed');
    expect(row.retry_count).toBe(5);
  });

  it('builds the Wave description as "vendor — summary"', async () => {
    ctx = await setupQueue();
    insertReceipt(ctx.db, { vendor: 'Home Depot', summary: 'Lumber' });
    ctx.createExpenseTransaction.mockResolvedValueOnce({ didSucceed: true, transactionId: 't', errors: [] });

    await ctx.queue.processQueue();

    expect(ctx.createExpenseTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ description: 'Home Depot — Lumber' }),
    );
  });

  it('falls back to "Expense" when neither vendor nor summary is set', async () => {
    ctx = await setupQueue();
    insertReceipt(ctx.db, { vendor: null, summary: null });
    ctx.createExpenseTransaction.mockResolvedValueOnce({ didSucceed: true, transactionId: 't', errors: [] });

    await ctx.queue.processQueue();

    expect(ctx.createExpenseTransaction).toHaveBeenCalledWith(expect.objectContaining({ description: 'Expense' }));
  });

  it('processes reviewed receipts oldest receipt_date first', async () => {
    ctx = await setupQueue();
    insertReceipt(ctx.db, { vendor: 'Later', receipt_date: '2026-03-01T00:00:00.000Z' });
    insertReceipt(ctx.db, { vendor: 'Earlier', receipt_date: '2026-01-01T00:00:00.000Z' });
    ctx.createExpenseTransaction.mockResolvedValue({ didSucceed: true, transactionId: 't', errors: [] });

    await ctx.queue.processQueue();

    const calls = ctx.createExpenseTransaction.mock.calls;
    expect(calls[0][0].date).toBe('2026-01-01');
    expect(calls[1][0].date).toBe('2026-03-01');
  });

  it('only sends a sales tax line when WAVE_SALES_TAX_ID is configured', async () => {
    ctx = await setupQueue({ WAVE_SALES_TAX_ID: 'tax-99' });
    insertReceipt(ctx.db);
    ctx.createExpenseTransaction.mockResolvedValueOnce({ didSucceed: true, transactionId: 't', errors: [] });

    await ctx.queue.processQueue();

    expect(ctx.createExpenseTransaction).toHaveBeenCalledWith(expect.objectContaining({ salesTaxId: 'tax-99' }));
  });
});

describe('retryReceipt / retryAll', () => {
  it('retryReceipt resets a single receipt to reviewed and re-triggers the queue', async () => {
    ctx = await setupQueue();
    const receipt = insertReceipt(ctx.db, { status: 'failed', retry_count: 3, last_error: 'boom' });
    ctx.createExpenseTransaction.mockResolvedValue({ didSucceed: true, transactionId: 'retried-txn', errors: [] });

    ctx.queue.retryReceipt(receipt.id);

    // Synchronous part of retryReceipt runs before any awaited work, so
    // this reflects immediately without needing to flush microtasks.
    const resetRow = getRow(ctx.db, receipt.id);
    expect(resetRow.status).toBe('reviewed');
    expect(resetRow.retry_count).toBe(0);
    expect(resetRow.last_error).toBeNull();

    // Let the fire-and-forget processQueue() it kicked off actually run.
    await new Promise((resolve) => setImmediate(resolve));
    expect(getRow(ctx.db, receipt.id).status).toBe('uploaded');
  });

  it('does not touch receipts that are not failed/needsAttention', async () => {
    ctx = await setupQueue();
    const uploaded = insertReceipt(ctx.db, { status: 'uploaded', wave_txn_id: 'old-txn' });

    ctx.queue.retryAll();

    expect(getRow(ctx.db, uploaded.id).status).toBe('uploaded');
  });

  it('retryAll resets every failed/needsAttention receipt and re-triggers the queue', async () => {
    ctx = await setupQueue();
    const a = insertReceipt(ctx.db, { status: 'failed', retry_count: 5, last_error: 'x' });
    const b = insertReceipt(ctx.db, { status: 'needsAttention', last_error: 'y' });
    ctx.createExpenseTransaction.mockResolvedValue({ didSucceed: true, transactionId: 't', errors: [] });

    ctx.queue.retryAll();

    expect(getRow(ctx.db, a.id).status).toBe('reviewed');
    expect(getRow(ctx.db, b.id).status).toBe('reviewed');

    await new Promise((resolve) => setImmediate(resolve));
    expect(getRow(ctx.db, a.id).status).toBe('uploaded');
    expect(getRow(ctx.db, b.id).status).toBe('uploaded');
  });
});

describe('background polling', () => {
  it('startPolling runs the queue immediately, then again every interval, and stopPolling stops it', async () => {
    ctx = await setupQueue();
    insertReceipt(ctx.db, { id: 'always-pending' });
    // Always resolve success so the "reviewed" receipt gets re-created each tick.
    ctx.createExpenseTransaction.mockResolvedValue({ didSucceed: true, transactionId: 't', errors: [] });

    vi.useFakeTimers();
    ctx.queue.startPolling();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.createExpenseTransaction).toHaveBeenCalledTimes(1);

    // Re-mark the receipt reviewed so there's something to process on the next tick.
    ctx.db.prepare(`UPDATE receipts SET status = 'reviewed' WHERE id = 'always-pending'`).run();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ctx.createExpenseTransaction).toHaveBeenCalledTimes(2);

    ctx.queue.stopPolling();
    ctx.db.prepare(`UPDATE receipts SET status = 'reviewed' WHERE id = 'always-pending'`).run();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(ctx.createExpenseTransaction).toHaveBeenCalledTimes(2);
  });
});
