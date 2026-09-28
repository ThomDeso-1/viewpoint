import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import request from 'supertest';
import { setupTestApp, fakeImageBytes, type TestContext } from '../helpers/testApp.js';
import { installFetchMock, jsonResponse } from '../helpers/fetchMock.js';

/**
 * Spec (AGENTS.md §1, migration 010 — receipts are a local tracking
 * system, no Wave upload, no approval gate):
 *  - An uploaded receipt is read by Claude automatically:
 *    captured → extracted, with Claude's confidence stored on the row.
 *  - Once read, its image is re-filed under the receipt's OWN date and
 *    vendor: `Receipts/<YYYY-MM>/<YYYY-MM-DD>_<vendor>_<id>.<ext>`.
 *  - With no Claude key the queue does nothing; rows wait in `captured`.
 *  - A retryable failure (5xx / rate limit / network) keeps the row in
 *    `captured` with stored backoff; a non-retryable one, or running out
 *    of retries, parks it in `needsAttention`.
 *  - An operator who filled the receipt in by hand while Claude was
 *    reading it keeps their values.
 */

const EXTRACTION = {
  receipt_date: '2024-05-01',
  vendor: 'The Coffee Spot',
  items: [{ description: 'Latte', amount: 5.5 }],
  summary_description: 'Coffee',
  subtotal: 5.5,
  taxes: [{ type: 'HST', rate: 0.13, amount: 0.72 }],
  total: 6.22,
  currency: 'CAD',
  confidence: 'medium',
};

function claudeTextResponse(payload: unknown) {
  return jsonResponse(200, { content: [{ text: JSON.stringify(payload) }] });
}

describe('receipt extract queue', () => {
  let ctx: TestContext;
  let fetchMock: ReturnType<typeof installFetchMock>;
  let processQueue: (storage: any) => Promise<void>;
  let storage: any;
  let db: any;

  async function setup(env: Record<string, string> = { CLAUDE_API_KEY: 'sk-ant-test-key' }) {
    ctx = await setupTestApp(env);
    // Same module registry as the app setupTestApp just built.
    ({ processQueue } = await import('../../server/receipts/extract-queue.js'));
    const { StorageService } = await import('../../server/receipts/storage.js');
    const { getDb } = await import('../../server/db/db.js');
    storage = new StorageService(ctx.dataDir);
    db = getDb();
  }

  async function upload(seed: string) {
    const res = await request(ctx.app)
      .post('/api/receipts')
      .attach('images', fakeImageBytes(seed), { filename: 'a.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(201);
    return res.body[0];
  }

  const get = async (id: string) => (await request(ctx.app).get(`/api/receipts/${id}`)).body;

  beforeEach(() => {
    fetchMock = installFetchMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    ctx?.teardown();
  });

  it('reads a captured receipt: fields, confidence, status=extracted', async () => {
    await setup();
    const r = await upload('q-ok');
    fetchMock.mockResolvedValueOnce(claudeTextResponse(EXTRACTION));

    await processQueue(storage);

    const after = await get(r.id);
    expect(after.status).toBe('extracted');
    expect(after.vendor).toBe('The Coffee Spot');
    expect(after.total_amount).toBe(6.22);
    expect(after.confidence).toBe('medium');
    expect(after.receipt_date).toBe('2024-05-01T00:00:00.000Z');
  });

  it("re-files the image under the receipt's own date and vendor, sidecar alongside", async () => {
    await setup();
    const r = await upload('q-refile');
    const oldAbs = `${ctx.dataDir}/Receipts/${r.primary_image}`;
    fetchMock.mockResolvedValueOnce(claudeTextResponse(EXTRACTION));

    await processQueue(storage);

    const after = await get(r.id);
    expect(after.month_folder).toBe('2024-05');
    expect(after.primary_image).toMatch(/^2024-05\/2024-05-01_the-coffee-spot_[0-9a-f]{8}\.jpg$/);
    expect(fs.existsSync(oldAbs)).toBe(false);
    const newAbs = `${ctx.dataDir}/Receipts/${after.primary_image}`;
    expect(fs.existsSync(newAbs)).toBe(true);
    expect(fs.existsSync(newAbs.replace(/\.jpg$/, '.json'))).toBe(true);
  });

  it('does nothing without a Claude key — the receipt waits in captured', async () => {
    await setup({});
    const r = await upload('q-nokey');

    await processQueue(storage);

    expect(fetchMock).not.toHaveBeenCalled();
    expect((await get(r.id)).status).toBe('captured');
  });

  it('keeps a receipt in captured with stored backoff after a retryable failure', async () => {
    await setup();
    const r = await upload('q-503');
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { error: { message: 'overloaded' } }));

    await processQueue(storage);
    const after = await get(r.id);
    expect(after.status).toBe('captured');
    expect(after.retry_count).toBe(1);
    expect(after.last_error).toBeTruthy();

    // Not due yet — an immediate second pass leaves it alone.
    await processQueue(storage);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('parks a non-retryable failure in needsAttention', async () => {
    await setup();
    const r = await upload('q-401');
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: { message: 'bad key' } }));

    await processQueue(storage);

    const after = await get(r.id);
    expect(after.status).toBe('needsAttention');
    expect(after.last_error).toBeTruthy();
  });

  it('gives up (needsAttention) once retries run out', async () => {
    await setup();
    const r = await upload('q-exhaust');
    db.prepare(`UPDATE receipts SET retry_count = 4, updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).run(r.id);
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { error: { message: 'still down' } }));

    await processQueue(storage);

    expect((await get(r.id)).status).toBe('needsAttention');
  });

  it('treats an unexpected confidence value as low, so it gets a second look', async () => {
    await setup();
    const r = await upload('q-conf');
    fetchMock.mockResolvedValueOnce(claudeTextResponse({ ...EXTRACTION, confidence: 'pretty sure' }));

    await processQueue(storage);

    expect((await get(r.id)).confidence).toBe('low');
  });

  it("doesn't overwrite a receipt the operator filled in while Claude was reading", async () => {
    await setup();
    const r = await upload('q-race');
    fetchMock.mockImplementationOnce(async () => {
      db.prepare(`UPDATE receipts SET status = 'reviewed', vendor = 'Typed By Hand' WHERE id = ?`).run(r.id);
      return claudeTextResponse(EXTRACTION);
    });

    await processQueue(storage);

    const after = await get(r.id);
    expect(after.status).toBe('reviewed');
    expect(after.vendor).toBe('Typed By Hand');
  });

  it('lists receipts under the month printed on them, not the upload month', async () => {
    await setup();
    const r = await upload('q-group');
    fetchMock.mockResolvedValueOnce(claudeTextResponse(EXTRACTION));
    await processQueue(storage);

    const list = (await request(ctx.app).get('/api/receipts')).body;
    const group = list.find((g: any) => g.receipts.some((x: any) => x.id === r.id));
    expect(group.month).toBe('2024-05');
  });
});
