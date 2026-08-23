import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestApp, fakeImageBytes, type TestContext } from './helpers/testApp.js';
import { installFetchMock, jsonResponse, networkFailure } from './helpers/fetchMock.js';

/**
 * Spec (CONVERSION-PLAN.md "Phase 2: Extraction"):
 *  - Without a configured Claude key, extraction is refused with a
 *    message telling the user to add one in Settings.
 *  - On success, the receipt moves from captured -> extracted and its
 *    vendor/summary/total/tax/currency/date are populated from Claude's
 *    structured response.
 *  - Claude error responses map to specific, user-meaningful error codes
 *    (invalid key, rate limited, insufficient credit, etc.)
 */
describe('receipt extraction (Claude API)', () => {
  let ctx: TestContext;
  let fetchMock: ReturnType<typeof installFetchMock>;

  beforeAll(async () => {
    ctx = await setupTestApp({ CLAUDE_API_KEY: 'sk-ant-test-key' });
  });

  afterAll(() => ctx.teardown());

  beforeEach(() => {
    fetchMock = installFetchMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function createReceipt(seed: string) {
    const res = await request(ctx.app)
      .post('/api/receipts')
      .attach('images', fakeImageBytes(seed), { filename: 'a.jpg', contentType: 'image/jpeg' });
    return res.body[0];
  }

  function claudeTextResponse(payload: unknown) {
    return jsonResponse(200, { content: [{ text: JSON.stringify(payload) }] });
  }

  it('404s for an unknown receipt', async () => {
    const res = await request(ctx.app).post('/api/receipts/does-not-exist/extract');
    expect(res.status).toBe(404);
  });

  it('populates receipt fields from a successful extraction and advances status to extracted', async () => {
    const receipt = await createReceipt('ext-ok');
    fetchMock.mockResolvedValueOnce(
      claudeTextResponse({
        receipt_date: '2024-05-01',
        vendor: 'The Coffee Spot',
        items: [{ description: 'Latte', amount: 5.5 }],
        summary_description: 'Coffee',
        subtotal: 5.5,
        taxes: [{ type: 'HST', rate: 0.13, amount: 0.72 }],
        total: 6.22,
        currency: 'CAD',
        confidence: 'high',
      }),
    );

    const res = await request(ctx.app).post(`/api/receipts/${receipt.id}/extract`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('extracted');
    expect(res.body.vendor).toBe('The Coffee Spot');
    expect(res.body.total_amount).toBe(6.22);
    expect(res.body.tax_amount).toBeCloseTo(0.72);
    expect(res.body.currency).toBe('CAD');
    expect(res.body.receipt_date.slice(0, 10)).toBe('2024-05-01');
  });

  it('sums multiple tax lines (e.g. GST + PST) into tax_amount', async () => {
    const receipt = await createReceipt('ext-multitax');
    fetchMock.mockResolvedValueOnce(
      claudeTextResponse({
        receipt_date: '2024-05-01',
        vendor: 'BC Store',
        items: [],
        summary_description: 'Stuff',
        subtotal: 100,
        taxes: [
          { type: 'GST', rate: 0.05, amount: 5 },
          { type: 'PST', rate: 0.07, amount: 7 },
        ],
        total: 112,
        currency: 'CAD',
        confidence: 'high',
      }),
    );

    const res = await request(ctx.app).post(`/api/receipts/${receipt.id}/extract`);
    expect(res.status).toBe(200);
    expect(res.body.tax_amount).toBe(12);
  });

  it('strips markdown code fences from the model response before parsing', async () => {
    const receipt = await createReceipt('ext-fenced');
    const payload = {
      receipt_date: '2024-05-01',
      vendor: 'Fenced Co',
      items: [],
      summary_description: 'x',
      subtotal: 1,
      taxes: [],
      total: 1,
      currency: 'CAD',
      confidence: 'high',
    };
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, { content: [{ text: '```json\n' + JSON.stringify(payload) + '\n```' }] }),
    );

    const res = await request(ctx.app).post(`/api/receipts/${receipt.id}/extract`);
    expect(res.status).toBe(200);
    expect(res.body.vendor).toBe('Fenced Co');
  });

  it('surfaces an unparseable model response as a 400 error rather than crashing', async () => {
    const receipt = await createReceipt('ext-badjson');
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { content: [{ text: 'not json at all' }] }));

    const res = await request(ctx.app).post(`/api/receipts/${receipt.id}/extract`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('maps an invalid API key (401) to a clear, non-retryable error', async () => {
    const receipt = await createReceipt('ext-401');
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: { message: 'invalid x-api-key' } }));

    const res = await request(ctx.app).post(`/api/receipts/${receipt.id}/extract`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_api_key');
  });

  it('maps insufficient credit (400 + billing message) to a friendly error', async () => {
    const receipt = await createReceipt('ext-credit');
    fetchMock.mockResolvedValueOnce(
      jsonResponse(400, { error: { message: 'Your account has insufficient credit balance.' } }),
    );

    const res = await request(ctx.app).post(`/api/receipts/${receipt.id}/extract`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('insufficient_credit');
  });

  it('maps rate limiting (429) to a 429 with retryAfter when provided', async () => {
    const receipt = await createReceipt('ext-429');
    fetchMock.mockResolvedValueOnce(jsonResponse(429, { error: { message: 'rate limited' } }, { 'retry-after': '30' }));

    const res = await request(ctx.app).post(`/api/receipts/${receipt.id}/extract`);
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('rate_limited');
    expect(res.body.retryAfter).toBe(30);
  });

  it('maps a 5xx from Claude to a server_error code', async () => {
    const receipt = await createReceipt('ext-5xx');
    fetchMock.mockResolvedValueOnce(jsonResponse(503, { error: { message: 'overloaded' } }));

    const res = await request(ctx.app).post(`/api/receipts/${receipt.id}/extract`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('server_error');
  });

  it('maps a network failure to a network_error code without throwing', async () => {
    const receipt = await createReceipt('ext-network');
    fetchMock.mockImplementationOnce(networkFailure());

    const res = await request(ctx.app).post(`/api/receipts/${receipt.id}/extract`);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('network_error');
  });

  it('leaves the receipt status untouched when extraction fails', async () => {
    const receipt = await createReceipt('ext-untouched');
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: { message: 'bad key' } }));
    await request(ctx.app).post(`/api/receipts/${receipt.id}/extract`);

    const after = await request(ctx.app).get(`/api/receipts/${receipt.id}`);
    expect(after.body.status).toBe('captured');
  });

  // Regression test: storage used to always save uploads as ".jpg"
  // regardless of their real format, which made a PNG/WEBP upload get
  // sent to Claude mislabeled as image/jpeg. Confirms the fix end-to-end.
  it('a non-JPEG upload keeps its real extension and is sent to Claude with the matching media_type', async () => {
    const created = await request(ctx.app)
      .post('/api/receipts')
      .attach('images', Buffer.from('fake-png-bytes'), { filename: 'a.png', contentType: 'image/png' });
    const receipt = created.body[0];
    expect(receipt.primary_image.endsWith('.png')).toBe(true);

    fetchMock.mockResolvedValueOnce(
      claudeTextResponse({
        receipt_date: '2024-05-01',
        vendor: 'PNG Vendor',
        items: [],
        summary_description: 'x',
        subtotal: 1,
        taxes: [],
        total: 1,
        currency: 'CAD',
        confidence: 'high',
      }),
    );
    const res = await request(ctx.app).post(`/api/receipts/${receipt.id}/extract`);
    expect(res.status).toBe(200);

    const sentBody = JSON.parse((fetchMock.mock.calls[0][1] as any).body);
    expect(sentBody.messages[0].content[0].source.media_type).toBe('image/png');
  });
});

describe('receipt extraction without a configured Claude key', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestApp(); // no CLAUDE_API_KEY
  });

  afterAll(() => ctx.teardown());

  it('refuses extraction and tells the user to add a key in Settings', async () => {
    const created = await request(ctx.app)
      .post('/api/receipts')
      .attach('images', fakeImageBytes('no-key'), { filename: 'a.jpg', contentType: 'image/jpeg' });

    const res = await request(ctx.app).post(`/api/receipts/${created.body[0].id}/extract`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/claude api key/i);
  });
});
