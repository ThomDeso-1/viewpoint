import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestApp, type TestContext } from '../helpers/testApp.js';
import { installFetchMock, jsonResponse, networkFailure } from '../helpers/fetchMock.js';

/**
 * The Microsoft integration: the OAuth connect/callback routes and the
 * Graph `sendMail` client, sharing the encrypted token store and callback
 * router with Google and Wave.
 */

const CLIENT_ID = 'test-ms-client-id';
const CLIENT_SECRET = 'test-ms-client-secret';
const CREDS = { MICROSOFT_CLIENT_ID: CLIENT_ID, MICROSOFT_CLIENT_SECRET: CLIENT_SECRET };

describe('Microsoft OAuth routes', () => {
  let ctx: TestContext;
  let token: string;

  async function bootstrap(env: Record<string, string> = {}) {
    ctx = await setupTestApp(env);
    await request(ctx.app).post('/api/auth/setup').send({ password: 'test-password' });
    const login = await request(ctx.app).post('/api/auth/login').send({ password: 'test-password' });
    const cookies = login.headers['set-cookie'] as unknown as string[];
    token = cookies.find((c) => c.startsWith('token='))!.split(';')[0].slice('token='.length);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    ctx?.teardown();
    delete process.env.MICROSOFT_CLIENT_ID;
    delete process.env.MICROSOFT_CLIENT_SECRET;
    delete process.env.MICROSOFT_TENANT;
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  it('reports not-configured before credentials are saved', async () => {
    await bootstrap();
    const res = await request(ctx.app).get('/api/microsoft/status').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(false);
    expect(res.body.connected).toBe(false);
  });

  it('requires a session for status', async () => {
    await bootstrap();
    expect((await request(ctx.app).get('/api/microsoft/status')).status).toBe(401);
  });

  it('saves credentials and then reports configured', async () => {
    await bootstrap();
    const save = await request(ctx.app)
      .post('/api/microsoft/credentials')
      .set(auth())
      .send({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    expect(save.status).toBe(200);

    const status = await request(ctx.app).get('/api/microsoft/status').set(auth());
    expect(status.body.configured).toBe(true);
    expect(status.body.redirectUri).toContain('/api/microsoft/callback');
  });

  it('refuses to start the flow before credentials exist', async () => {
    await bootstrap();
    const res = await request(ctx.app).get('/api/microsoft/connect').set(auth());
    expect(res.status).toBe(400);
  });

  it('redirects to the Microsoft consent screen with the expected parameters', async () => {
    await bootstrap(CREDS);
    const res = await request(ctx.app).get('/api/microsoft/connect').set(auth());
    expect(res.status).toBe(302);

    const url = new URL(res.headers.location);
    expect(url.origin + url.pathname).toBe(
      'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    );
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('scope')).toContain('Mail.Send');
    expect(url.searchParams.get('scope')).toContain('offline_access');
  });

  it('honours MICROSOFT_TENANT in the authorize URL', async () => {
    await bootstrap({ ...CREDS, MICROSOFT_TENANT: 'contoso.onmicrosoft.com' });
    const res = await request(ctx.app).get('/api/microsoft/connect').set(auth());
    expect(new URL(res.headers.location).pathname).toBe(
      '/contoso.onmicrosoft.com/oauth2/v2.0/authorize',
    );
  });

  describe('callback', () => {
    async function startFlow(): Promise<string> {
      const res = await request(ctx.app).get('/api/microsoft/connect').set(auth());
      return new URL(res.headers.location).searchParams.get('state')!;
    }

    it('is reachable without a session', async () => {
      await bootstrap(CREDS);
      const res = await request(ctx.app).get('/api/microsoft/callback?code=x&state=bogus');
      expect(res.status).not.toBe(401);
    });

    it('rejects a state it never issued', async () => {
      await bootstrap(CREDS);
      const res = await request(ctx.app).get('/api/microsoft/callback?code=abc&state=forged');
      expect(res.status).toBe(400);
    });

    it('exchanges the code and stores the tokens', async () => {
      await bootstrap(CREDS);
      const state = await startFlow();

      const mock = installFetchMock();
      mock
        .mockResolvedValueOnce(
          jsonResponse(200, {
            access_token: 'ms-access',
            refresh_token: 'ms-refresh',
            expires_in: 3600,
            scope: 'Mail.Send offline_access',
          }),
        )
        .mockResolvedValueOnce(jsonResponse(200, { mail: 'reception@contoso.com' }));

      const res = await request(ctx.app).get(`/api/microsoft/callback?code=the-code&state=${state}`);
      expect(res.status).toBe(200);
      expect(res.text).toContain('Microsoft connected');

      const store = await import('../../server/platform/oauth-store.js');
      const tokens = store.getTokens('microsoft')!;
      expect(tokens.accessToken).toBe('ms-access');
      expect(tokens.refreshToken).toBe('ms-refresh');
      expect(store.connectionStatus('microsoft').accountLabel).toBe('reception@contoso.com');
    });

    it('reports a token-exchange failure instead of claiming success', async () => {
      await bootstrap(CREDS);
      const state = await startFlow();

      const mock = installFetchMock();
      mock.mockResolvedValue(jsonResponse(400, { error: 'invalid_grant' }));

      const res = await request(ctx.app).get(`/api/microsoft/callback?code=bad&state=${state}`);
      expect(res.status).toBe(502);
      expect(res.text).toContain('Connection failed');
    });

    it('reports a network failure during exchange', async () => {
      await bootstrap(CREDS);
      const state = await startFlow();

      const mock = installFetchMock();
      mock.mockImplementation(networkFailure());

      const res = await request(ctx.app).get(`/api/microsoft/callback?code=x&state=${state}`);
      expect(res.status).toBe(502);
    });
  });

  it('disconnecting clears the stored tokens', async () => {
    await bootstrap();
    const store = await import('../../server/platform/oauth-store.js');
    store.saveTokens('microsoft', { accessToken: 'a', refreshToken: 'b' });

    const res = await request(ctx.app).post('/api/microsoft/disconnect').set(auth());
    expect(res.status).toBe(200);
    expect(store.isConnected('microsoft')).toBe(false);
  });
});

describe('Graph sendMail', () => {
  let ctx: TestContext;
  let graph: typeof import('../../server/integrations/microsoft/graph.js');

  beforeEach(async () => {
    ctx = await setupTestApp({ ...CREDS });
    graph = await import('../../server/integrations/microsoft/graph.js');
    const store = await import('../../server/platform/oauth-store.js');
    store.saveTokens('microsoft', {
      accessToken: 'valid-token',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    ctx.teardown();
    delete process.env.MICROSOFT_CLIENT_ID;
    delete process.env.MICROSOFT_CLIENT_SECRET;
  });

  it('posts a plain-text message to the connected mailbox', async () => {
    const mock = installFetchMock();
    mock.mockResolvedValue(new Response(null, { status: 202 }));

    const id = await graph.sendMail({ to: 'patient@example.com', subject: 'Reminder', body: 'Tomorrow at 10.' });
    expect(id).toMatch(/^graph-/);

    const [, init] = mock.mock.calls[0];
    const payload = JSON.parse((init as RequestInit).body as string);
    expect(payload.message.toRecipients[0].emailAddress.address).toBe('patient@example.com');
    expect(payload.message.body.contentType).toBe('Text');
    expect(payload.message.body.content).toBe('Tomorrow at 10.');
  });

  it('treats a 401 as a broken connection, not a retryable blip', async () => {
    const mock = installFetchMock();
    mock.mockResolvedValue(jsonResponse(401, { error: { code: 'InvalidAuthenticationToken' } }));

    await expect(
      graph.sendMail({ to: 'a@b.com', subject: 'x', body: 'y' }),
    ).rejects.toMatchObject({ code: 'not_connected', isRetryable: false });
  });

  it('treats a 503 as retryable', async () => {
    const mock = installFetchMock();
    mock.mockResolvedValue(jsonResponse(503, {}));

    await expect(
      graph.sendMail({ to: 'a@b.com', subject: 'x', body: 'y' }),
    ).rejects.toMatchObject({ code: 'server_error', isRetryable: true });
  });
});

describe('email provider selection', () => {
  let ctx: TestContext;
  afterEach(() => {
    ctx?.teardown();
    delete process.env.EMAIL_PROVIDER;
  });

  it('defaults to google', async () => {
    ctx = await setupTestApp();
    const email = await import('../../server/integrations/email/index.js');
    expect(email.emailProviderName()).toBe('google');
    expect(email.getEmailProvider().name).toBe('google');
  });

  it('switches to microsoft when EMAIL_PROVIDER is set', async () => {
    ctx = await setupTestApp({ EMAIL_PROVIDER: 'microsoft' });
    const email = await import('../../server/integrations/email/index.js');
    expect(email.getEmailProvider().name).toBe('microsoft');
  });
});
