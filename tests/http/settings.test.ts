import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import request from 'supertest';
import { setupTestApp, type TestContext } from '../helpers/testApp.js';
import { installFetchMock, jsonResponse, networkFailure } from '../helpers/fetchMock.js';

/**
 * Spec (GETTING-STARTED.md Step 5, CONVERSION-PLAN.md Settings Page /
 * Settings Validation Endpoints):
 *  - Settings never leaks full API keys/tokens back to the client — only
 *    a masked preview.
 *  - Validating a Claude key / Wave token tests it live but does not
 *    persist it; saving persists it to .env and applies it immediately
 *    (no restart needed).
 *  - /api/settings/health is a cheap, cached (5 min) credential check for
 *    a banner, not a full validation on every page load.
 */
describe('settings', () => {
  let ctx: TestContext;
  let fetchMock: ReturnType<typeof installFetchMock>;

  beforeAll(async () => {
    ctx = await setupTestApp();
  });

  afterAll(() => ctx.teardown());

  beforeEach(() => {
    fetchMock = installFetchMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('reading current config', () => {
    it('reports no keys configured out of the box', async () => {
      const res = await request(ctx.app).get('/api/settings');
      expect(res.status).toBe(200);
      expect(res.body.hasClaudeKey).toBe(false);
      expect(res.body.hasWaveToken).toBe(false);
      expect(res.body.claudeKeyPreview).toBeNull();
      expect(res.body.isOnboarded).toBe(false);
    });
  });

  describe('saving the Claude API key', () => {
    it('requires an apiKey', async () => {
      const res = await request(ctx.app).post('/api/settings/claude-key').send({});
      expect(res.status).toBe(400);
    });

    it('persists the key to .env and applies it to the running process immediately', async () => {
      const res = await request(ctx.app)
        .post('/api/settings/claude-key')
        .send({ apiKey: 'sk-ant-abcdefghijklmnop' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });

      // Applied immediately, no restart needed.
      expect(process.env.CLAUDE_API_KEY).toBe('sk-ant-abcdefghijklmnop');

      // Persisted to disk so it survives a restart.
      const envPath = `${process.cwd()}/.env`;
      expect(fs.existsSync(envPath)).toBe(true);
      expect(fs.readFileSync(envPath, 'utf-8')).toContain('CLAUDE_API_KEY=sk-ant-abcdefghijklmnop');
    });

    it('never echoes the full key back — only a masked preview', async () => {
      const res = await request(ctx.app).get('/api/settings');
      expect(res.body.hasClaudeKey).toBe(true);
      expect(res.body.claudeKeyPreview).not.toContain('abcdefghijklmnop');
      expect(res.body.claudeKeyPreview).toMatch(/…/);
    });
  });

  describe('saving the Wave connection', () => {
    it('requires both a token and a business id', async () => {
      const res = await request(ctx.app).post('/api/settings/wave-connection').send({ token: 'abc' });
      expect(res.status).toBe(400);
    });

    it('persists token + business selection', async () => {
      const res = await request(ctx.app).post('/api/settings/wave-connection').send({
        token: 'wave-token-xyz',
        businessId: 'biz-123',
        businessName: 'My Business',
      });
      expect(res.status).toBe(200);

      const settings = await request(ctx.app).get('/api/settings');
      expect(settings.body.hasWaveToken).toBe(true);
      expect(settings.body.waveBusinessId).toBe('biz-123');
      expect(settings.body.waveBusinessName).toBe('My Business');
    });
  });

  describe('saving Wave accounts', () => {
    it('requires both expense and anchor account ids', async () => {
      const res = await request(ctx.app).post('/api/settings/wave-accounts').send({ expenseAccountId: 'e1' });
      expect(res.status).toBe(400);
    });

    it('persists expense/anchor/sales-tax selections', async () => {
      const res = await request(ctx.app).post('/api/settings/wave-accounts').send({
        expenseAccountId: 'expense-1',
        anchorAccountId: 'anchor-1',
        salesTaxId: 'tax-1',
      });
      expect(res.status).toBe(200);

      const settings = await request(ctx.app).get('/api/settings');
      expect(settings.body.waveExpenseAccountId).toBe('expense-1');
      expect(settings.body.waveAnchorAccountId).toBe('anchor-1');
      expect(settings.body.waveSalesTaxId).toBe('tax-1');
    });
  });

  describe('validating a Claude key (live check, not persisted)', () => {
    it('requires an apiKey', async () => {
      const res = await request(ctx.app).post('/api/settings/validate-claude-key').send({});
      expect(res.status).toBe(400);
    });

    it('reports valid:true for a working key without changing saved settings', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { content: [{ text: 'OK' }] }));
      const before = await request(ctx.app).get('/api/settings');

      const res = await request(ctx.app).post('/api/settings/validate-claude-key').send({ apiKey: 'sk-test-live' });
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);

      const after = await request(ctx.app).get('/api/settings');
      expect(after.body.claudeKeyPreview).toBe(before.body.claudeKeyPreview);
    });

    it('reports valid:false with a message for a bad key, not an HTTP error', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(401, { error: { message: 'invalid x-api-key' } }));
      const res = await request(ctx.app).post('/api/settings/validate-claude-key').send({ apiKey: 'sk-bad' });
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
      expect(res.body.error).toBeTruthy();
    });
  });

  describe('validating a Wave token', () => {
    it('requires a token', async () => {
      const res = await request(ctx.app).post('/api/settings/validate-wave-token').send({});
      expect(res.status).toBe(400);
    });

    it('returns the business list for a working token', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, {
          data: { businesses: { edges: [{ node: { id: 'b1', name: 'Acme Co', isPersonal: false } }] } },
        }),
      );
      const res = await request(ctx.app).post('/api/settings/validate-wave-token').send({ token: 'wv-good' });
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(true);
      expect(res.body.businesses).toEqual([{ id: 'b1', name: 'Acme Co', isPersonal: false }]);
    });

    it('reports valid:false when the token has no business on it', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(200, { data: { businesses: { edges: [] } } }));
      const res = await request(ctx.app).post('/api/settings/validate-wave-token').send({ token: 'wv-empty' });
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
    });

    it('reports valid:false for an expired/invalid token', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(401, {}));
      const res = await request(ctx.app).post('/api/settings/validate-wave-token').send({ token: 'wv-bad' });
      expect(res.status).toBe(200);
      expect(res.body.valid).toBe(false);
    });
  });

  describe('onboarding', () => {
    it('marks onboarding complete', async () => {
      const before = await request(ctx.app).get('/api/settings');
      expect(before.body.isOnboarded).toBe(false);

      const res = await request(ctx.app).post('/api/settings/onboard');
      expect(res.status).toBe(200);

      const after = await request(ctx.app).get('/api/settings');
      expect(after.body.isOnboarded).toBe(true);
    });
  });
});

describe('settings: Wave accounts/taxes require a configured connection', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestApp(); // no Wave token/business configured
  });

  afterAll(() => ctx.teardown());

  it('refuses to fetch accounts without a configured token+business', async () => {
    const res = await request(ctx.app).get('/api/settings/wave/accounts');
    expect(res.status).toBe(400);
  });

  it('refuses to fetch taxes without a configured token+business', async () => {
    const res = await request(ctx.app).get('/api/settings/wave/taxes');
    expect(res.status).toBe(400);
  });

  it('reports unhealthy with no token configured', async () => {
    const res = await request(ctx.app).get('/api/settings/wave/health');
    expect(res.status).toBe(200);
    expect(res.body.healthy).toBe(false);
  });
});

describe('settings: health banner', () => {
  // The health-check result is cached in-module for 5 minutes, so each
  // test needs its own fresh app (and thus fresh cache) rather than
  // sharing one across a describe block.
  let ctx: TestContext;
  let fetchMock: ReturnType<typeof installFetchMock>;

  beforeEach(async () => {
    ctx = await setupTestApp({
      CLAUDE_API_KEY: 'sk-health-check',
      WAVE_ACCESS_TOKEN: 'wave-health-check',
    });
    fetchMock = installFetchMock();
  });

  afterEach(() => {
    ctx.teardown();
    vi.unstubAllGlobals();
  });

  it('reports both configured + healthy when both credentials work', async () => {
    fetchMock.mockImplementation(async (url: any) => {
      const s = String(url);
      if (s.includes('anthropic.com')) return jsonResponse(200, { content: [{ text: 'OK' }] });
      return jsonResponse(200, { data: { businesses: { edges: [{ node: { id: 'b1', name: 'B', isPersonal: false } }] } } });
    });

    const res = await request(ctx.app).get('/api/settings/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      claudeConfigured: true,
      claudeHealthy: true,
      waveConfigured: true,
      waveHealthy: true,
    });
  });

  it('reports unhealthy when the Claude key has gone bad, without throwing', async () => {
    fetchMock.mockImplementation(async (url: any) => {
      const s = String(url);
      if (s.includes('anthropic.com')) return jsonResponse(401, {});
      return jsonResponse(200, { data: { businesses: { edges: [{ node: { id: 'b1', name: 'B', isPersonal: false } }] } } });
    });

    const res = await request(ctx.app).get('/api/settings/health');
    expect(res.status).toBe(200);
    expect(res.body.claudeHealthy).toBe(false);
  });

  it('reports Wave unhealthy on a network failure without throwing', async () => {
    fetchMock.mockImplementation(async (url: any) => {
      const s = String(url);
      if (s.includes('anthropic.com')) return jsonResponse(200, { content: [{ text: 'OK' }] });
      return networkFailure()();
    });

    const res = await request(ctx.app).get('/api/settings/health');
    expect(res.status).toBe(200);
    expect(res.body.waveHealthy).toBe(false);
  });
});
