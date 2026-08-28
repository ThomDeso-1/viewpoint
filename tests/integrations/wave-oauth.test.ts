import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestApp, type TestContext } from '../helpers/testApp.js';
import { installFetchMock, jsonResponse, networkFailure } from '../helpers/fetchMock.js';

/**
 * Wave OAuth — the alternative to the pasted access token.
 *
 * Token mode stays the default because OAuth additionally requires a Wave
 * Pro subscription and an HTTPS redirect URI, so these tests care mostly
 * that switching modes is deliberate and that the callback is safe.
 */

const CLIENT_ID = 'wave-client-id';
const CLIENT_SECRET = 'wave-client-secret';
const PASSWORD = 'test-password';

describe('Wave OAuth', () => {
  let ctx: TestContext;
  let token: string;

  beforeEach(async () => {
    ctx = await setupTestApp();
    await request(ctx.app).post('/api/auth/setup').send({ password: PASSWORD });
    const login = await request(ctx.app).post('/api/auth/login').send({ password: PASSWORD });
    const cookies = login.headers['set-cookie'] as unknown as string[];
    token = cookies.find((c) => c.startsWith('token='))!.split(';')[0].slice('token='.length);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    ctx.teardown();
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  async function saveCredentials() {
    return request(ctx.app)
      .post('/api/wave/credentials')
      .set(auth())
      .send({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  }

  it('defaults to token mode, not OAuth', async () => {
    const res = await request(ctx.app).get('/api/wave/status').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('token');
    expect(res.body.configured).toBe(false);
    expect(res.body.connected).toBe(false);
  });

  it('requires a session', async () => {
    expect((await request(ctx.app).get('/api/wave/status')).status).toBe(401);
  });

  it('rejects incomplete credentials', async () => {
    const res = await request(ctx.app)
      .post('/api/wave/credentials')
      .set(auth())
      .send({ clientId: CLIENT_ID });
    expect(res.status).toBe(400);
  });

  it('refuses to switch to OAuth before a client is configured', async () => {
    const res = await request(ctx.app).post('/api/wave/mode').set(auth()).send({ mode: 'oauth' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/client ID and secret/i);
  });

  it('rejects a mode it does not recognise', async () => {
    const res = await request(ctx.app).post('/api/wave/mode').set(auth()).send({ mode: 'sometimes' });
    expect(res.status).toBe(400);
  });

  it('switches to OAuth once a client is configured, and back again', async () => {
    await saveCredentials();

    const toOauth = await request(ctx.app).post('/api/wave/mode').set(auth()).send({ mode: 'oauth' });
    expect(toOauth.status).toBe(200);
    expect((await request(ctx.app).get('/api/wave/status').set(auth())).body.mode).toBe('oauth');

    await request(ctx.app).post('/api/wave/mode').set(auth()).send({ mode: 'token' });
    expect((await request(ctx.app).get('/api/wave/status').set(auth())).body.mode).toBe('token');
  });

  it('refuses to start the flow before credentials exist', async () => {
    const res = await request(ctx.app).get('/api/wave/connect').set(auth());
    expect(res.status).toBe(400);
  });

  it('redirects to Wave with the expected parameters', async () => {
    await saveCredentials();

    const res = await request(ctx.app).get('/api/wave/connect').set(auth());
    expect(res.status).toBe(302);

    const url = new URL(res.headers.location);
    expect(url.origin + url.pathname).toBe('https://api.waveapps.com/oauth2/authorize');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('scope')).toContain('invoice:write');
    expect(url.searchParams.get('scope')).toContain('customer:write');
  });

  describe('callback', () => {
    async function startFlow(): Promise<string> {
      await saveCredentials();
      const res = await request(ctx.app).get('/api/wave/connect').set(auth());
      return new URL(res.headers.location).searchParams.get('state')!;
    }

    it('is reachable without a session, since Wave redirects the browser here', async () => {
      const res = await request(ctx.app).get('/api/wave/callback?code=x&state=bogus');
      expect(res.status).not.toBe(401);
    });

    it('rejects a state it never issued', async () => {
      const res = await request(ctx.app).get('/api/wave/callback?code=abc&state=forged');
      expect(res.status).toBe(400);
      expect(res.text).toContain('expired or was already used');
    });

    it('rejects a replayed state', async () => {
      const state = await startFlow();
      const mock = installFetchMock();
      mock.mockResolvedValue(jsonResponse(200, { access_token: 'a', expires_in: 7200 }));

      expect((await request(ctx.app).get(`/api/wave/callback?code=abc&state=${state}`)).status).toBe(200);
      expect((await request(ctx.app).get(`/api/wave/callback?code=abc&state=${state}`)).status).toBe(400);
    });

    it('surfaces a denial from Wave', async () => {
      const res = await request(ctx.app).get('/api/wave/callback?error=access_denied&state=x');
      expect(res.status).toBe(400);
      expect(res.text).toContain('access_denied');
    });

    it('exchanges the code and stores the tokens encrypted', async () => {
      const state = await startFlow();

      const mock = installFetchMock();
      mock.mockResolvedValue(
        jsonResponse(200, {
          access_token: 'wave-access',
          refresh_token: 'wave-refresh',
          expires_in: 7200,
          scope: 'invoice:write',
        }),
      );

      const res = await request(ctx.app).get(`/api/wave/callback?code=the-code&state=${state}`);
      expect(res.status).toBe(200);
      expect(res.text).toContain('Wave connected');

      const store = await import('../../server/platform/oauth-store.js');
      const tokens = store.getTokens('wave')!;
      expect(tokens.accessToken).toBe('wave-access');
      expect(tokens.refreshToken).toBe('wave-refresh');
    });

    it('reports a rejected exchange rather than claiming success', async () => {
      const state = await startFlow();
      const mock = installFetchMock();
      mock.mockResolvedValue(jsonResponse(400, { error: 'invalid_grant' }));

      const res = await request(ctx.app).get(`/api/wave/callback?code=bad&state=${state}`);
      expect(res.status).toBe(502);
      expect(res.text).toContain('Connection failed');
    });

    it('reports a network failure during exchange', async () => {
      const state = await startFlow();
      const mock = installFetchMock();
      mock.mockImplementation(networkFailure());

      expect((await request(ctx.app).get(`/api/wave/callback?code=x&state=${state}`)).status).toBe(502);
    });
  });

  it('disconnecting clears the stored tokens', async () => {
    const store = await import('../../server/platform/oauth-store.js');
    store.saveTokens('wave', { accessToken: 'a', refreshToken: 'b' });

    const res = await request(ctx.app).post('/api/wave/disconnect').set(auth());
    expect(res.status).toBe(200);
    expect(store.isConnected('wave')).toBe(false);
  });

  describe('token resolution', () => {
    it('returns the pasted token in token mode', async () => {
      process.env.WAVE_ACCESS_TOKEN = 'pasted-token';
      const waveAuth = await import('../../server/integrations/wave/auth.js');

      expect(await waveAuth.getWaveToken()).toBe('pasted-token');
    });

    it('refreshes an expired OAuth token rather than failing', async () => {
      process.env.WAVE_AUTH_MODE = 'oauth';
      process.env.WAVE_CLIENT_ID = CLIENT_ID;
      process.env.WAVE_CLIENT_SECRET = CLIENT_SECRET;

      const store = await import('../../server/platform/oauth-store.js');
      const waveAuth = await import('../../server/integrations/wave/auth.js');

      store.saveTokens('wave', {
        accessToken: 'stale',
        refreshToken: 'refresh-me',
        expiresAt: new Date(Date.now() - 1000),
      });

      const mock = installFetchMock();
      mock.mockResolvedValue(jsonResponse(200, { access_token: 'fresh', expires_in: 7200 }));

      expect(await waveAuth.getWaveToken()).toBe('fresh');
      // Wave omits refresh_token on refresh; the stored one must survive.
      expect(store.getTokens('wave')!.refreshToken).toBe('refresh-me');
    });

    it('asks the user to reconnect when the refresh token is gone', async () => {
      process.env.WAVE_AUTH_MODE = 'oauth';
      process.env.WAVE_CLIENT_ID = CLIENT_ID;
      process.env.WAVE_CLIENT_SECRET = CLIENT_SECRET;

      const store = await import('../../server/platform/oauth-store.js');
      const waveAuth = await import('../../server/integrations/wave/auth.js');

      store.saveTokens('wave', { accessToken: 'stale', expiresAt: new Date(Date.now() - 1000) });

      await expect(waveAuth.getWaveToken()).rejects.toMatchObject({ code: 'token_expired' });
    });
  });
});
