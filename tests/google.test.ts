import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import path from 'path';
import Database from 'better-sqlite3';
import { setupTestApp, type TestContext } from './helpers/testApp.js';
import { installFetchMock, jsonResponse, networkFailure } from './helpers/fetchMock.js';

/**
 * The Google integration: encrypted token storage, the OAuth connect and
 * callback routes, and the Gmail/Calendar clients built on top of them.
 */

const CLIENT_ID = 'test-client-id.apps.googleusercontent.com';
const CLIENT_SECRET = 'test-client-secret';

describe('OAuth token storage', () => {
  let ctx: TestContext;
  let store: typeof import('../server/services/oauth-store.js');

  beforeEach(async () => {
    ctx = await setupTestApp();
    store = await import('../server/services/oauth-store.js');
  });
  afterEach(() => ctx.teardown());

  function rawTokenRow() {
    const db = new Database(path.join(ctx.dataDir, 'receipts.db'), { readonly: true });
    const row = db.prepare(`SELECT * FROM oauth_tokens WHERE provider = 'google'`).get() as
      | Record<string, unknown>
      | undefined;
    db.close();
    return row;
  }

  it('encrypts both tokens at rest', () => {
    store.saveTokens('google', { accessToken: 'access-abc', refreshToken: 'refresh-xyz' });

    const raw = rawTokenRow()!;
    expect(JSON.stringify(raw)).not.toContain('access-abc');
    expect(JSON.stringify(raw)).not.toContain('refresh-xyz');

    const round = store.getTokens('google')!;
    expect(round.accessToken).toBe('access-abc');
    expect(round.refreshToken).toBe('refresh-xyz');
  });

  it('keeps the existing refresh token when a refresh response omits one', () => {
    store.saveTokens('google', { accessToken: 'access-1', refreshToken: 'refresh-original' });

    // A refresh response typically returns only a new access token.
    store.saveTokens('google', { accessToken: 'access-2' });

    const after = store.getTokens('google')!;
    expect(after.accessToken).toBe('access-2');
    expect(after.refreshToken).toBe('refresh-original');
  });

  it('treats a token near its expiry as already expired', () => {
    store.saveTokens('google', {
      accessToken: 'a',
      expiresAt: new Date(Date.now() + 60_000), // inside the 5-minute skew
    });
    expect(store.isExpired(store.getTokens('google')!)).toBe(true);

    store.saveTokens('google', { accessToken: 'a', expiresAt: new Date(Date.now() + 3_600_000) });
    expect(store.isExpired(store.getTokens('google')!)).toBe(false);
  });

  it('treats a token with no stated expiry as usable', () => {
    store.saveTokens('google', { accessToken: 'a' });
    expect(store.isExpired(store.getTokens('google')!)).toBe(false);
  });

  it('reports connection status without exposing tokens', () => {
    store.saveTokens('google', {
      accessToken: 'secret-token',
      accountLabel: 'doc@example.com',
      scope: 'gmail.readonly',
    });

    const status = store.connectionStatus('google');
    expect(status.connected).toBe(true);
    expect(status.accountLabel).toBe('doc@example.com');
    expect(JSON.stringify(status)).not.toContain('secret-token');
  });

  it('forgets everything on disconnect', () => {
    store.saveTokens('google', { accessToken: 'a', refreshToken: 'b' });
    store.disconnect('google');

    expect(store.isConnected('google')).toBe(false);
    expect(store.getTokens('google')).toBeUndefined();
    expect(rawTokenRow()).toBeUndefined();
  });

  it('keeps providers independent', () => {
    store.saveTokens('google', { accessToken: 'google-token' });
    store.saveTokens('wave', { accessToken: 'wave-token' });

    expect(store.getTokens('google')!.accessToken).toBe('google-token');
    expect(store.getTokens('wave')!.accessToken).toBe('wave-token');

    store.disconnect('google');
    expect(store.isConnected('wave')).toBe(true);
  });
});

describe('Google OAuth routes', () => {
  let ctx: TestContext;
  let token: string;

  beforeEach(async () => {
    ctx = await setupTestApp();
    await request(ctx.app).post('/api/auth/setup').send({ password: 'test-password' });
    const login = await request(ctx.app).post('/api/auth/login').send({ password: 'test-password' });
    const cookies = login.headers['set-cookie'] as unknown as string[];
    token = cookies.find((c) => c.startsWith('token='))!.split(';')[0].slice('token='.length);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    ctx.teardown();
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  it('reports not-configured before credentials are saved', async () => {
    const res = await request(ctx.app).get('/api/google/status').set(auth());
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(false);
    expect(res.body.connected).toBe(false);
  });

  it('requires a session for status', async () => {
    expect((await request(ctx.app).get('/api/google/status')).status).toBe(401);
  });

  it('rejects incomplete credentials', async () => {
    const res = await request(ctx.app)
      .post('/api/google/credentials')
      .set(auth())
      .send({ clientId: CLIENT_ID });
    expect(res.status).toBe(400);
  });

  it('saves credentials and then reports configured', async () => {
    const save = await request(ctx.app)
      .post('/api/google/credentials')
      .set(auth())
      .send({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
    expect(save.status).toBe(200);

    const status = await request(ctx.app).get('/api/google/status').set(auth());
    expect(status.body.configured).toBe(true);
    expect(status.body.redirectUri).toContain('/api/google/callback');
  });

  it('refuses to start the flow before credentials exist', async () => {
    const res = await request(ctx.app).get('/api/google/connect').set(auth());
    expect(res.status).toBe(400);
  });

  it('redirects to Google consent with the expected parameters', async () => {
    await request(ctx.app)
      .post('/api/google/credentials')
      .set(auth())
      .send({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });

    const res = await request(ctx.app).get('/api/google/connect').set(auth());
    expect(res.status).toBe(302);

    const url = new URL(res.headers.location);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('response_type')).toBe('code');
    // Both are required for Google to return a refresh token at all.
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('scope')).toContain('gmail.readonly');
    expect(url.searchParams.get('scope')).toContain('calendar.events');
  });

  describe('callback', () => {
    async function startFlow(): Promise<string> {
      await request(ctx.app)
        .post('/api/google/credentials')
        .set(auth())
        .send({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
      const res = await request(ctx.app).get('/api/google/connect').set(auth());
      return new URL(res.headers.location).searchParams.get('state')!;
    }

    it('is reachable without a session, since Google redirects the browser here', async () => {
      // sameSite=strict means no cookie on this navigation; a 401 would
      // make the flow impossible to complete.
      const res = await request(ctx.app).get('/api/google/callback?code=x&state=bogus');
      expect(res.status).not.toBe(401);
    });

    it('rejects a state it never issued', async () => {
      const res = await request(ctx.app).get('/api/google/callback?code=abc&state=forged');
      expect(res.status).toBe(400);
      expect(res.text).toContain('expired or was already used');
    });

    it('rejects a replayed state', async () => {
      const state = await startFlow();
      const mock = installFetchMock();
      mock.mockResolvedValue(jsonResponse(200, { access_token: 'a', expires_in: 3600 }));

      const first = await request(ctx.app).get(`/api/google/callback?code=abc&state=${state}`);
      expect(first.status).toBe(200);

      const replay = await request(ctx.app).get(`/api/google/callback?code=abc&state=${state}`);
      expect(replay.status).toBe(400);
    });

    it('surfaces a consent-screen denial', async () => {
      const res = await request(ctx.app).get('/api/google/callback?error=access_denied&state=x');
      expect(res.status).toBe(400);
      expect(res.text).toContain('access_denied');
    });

    it('exchanges the code and stores the tokens', async () => {
      const state = await startFlow();

      const mock = installFetchMock();
      mock
        .mockResolvedValueOnce(
          jsonResponse(200, {
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            expires_in: 3600,
            scope: 'gmail.readonly',
          }),
        )
        .mockResolvedValueOnce(jsonResponse(200, { email: 'doc@example.com' }));

      const res = await request(ctx.app).get(`/api/google/callback?code=the-code&state=${state}`);
      expect(res.status).toBe(200);
      expect(res.text).toContain('Google connected');

      const store = await import('../server/services/oauth-store.js');
      const tokens = store.getTokens('google')!;
      expect(tokens.accessToken).toBe('new-access');
      expect(tokens.refreshToken).toBe('new-refresh');
      expect(store.connectionStatus('google').accountLabel).toBe('doc@example.com');
    });

    it('reports a token-exchange failure instead of claiming success', async () => {
      const state = await startFlow();

      const mock = installFetchMock();
      mock.mockResolvedValue(jsonResponse(400, { error: 'invalid_grant' }));

      const res = await request(ctx.app).get(`/api/google/callback?code=bad&state=${state}`);
      expect(res.status).toBe(502);
      expect(res.text).toContain('Connection failed');
    });

    it('reports a network failure during exchange', async () => {
      const state = await startFlow();

      const mock = installFetchMock();
      mock.mockImplementation(networkFailure());

      const res = await request(ctx.app).get(`/api/google/callback?code=x&state=${state}`);
      expect(res.status).toBe(502);
    });
  });

  it('disconnecting clears the stored tokens', async () => {
    const store = await import('../server/services/oauth-store.js');
    store.saveTokens('google', { accessToken: 'a', refreshToken: 'b' });

    const res = await request(ctx.app).post('/api/google/disconnect').set(auth());
    expect(res.status).toBe(200);
    expect(store.isConnected('google')).toBe(false);
  });
});

describe('Gmail message parsing', () => {
  let ctx: TestContext;
  let gmail: typeof import('../server/services/gmail.js');

  beforeEach(async () => {
    ctx = await setupTestApp();
    gmail = await import('../server/services/gmail.js');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    ctx.teardown();
  });

  const b64 = (s: string) => Buffer.from(s).toString('base64url');

  it('reads a top-level plain-text body', () => {
    const body = gmail.extractBody({ mimeType: 'text/plain', body: { data: b64('Hello there') } });
    expect(body).toBe('Hello there');
  });

  it('finds the plain-text part inside a multipart message', () => {
    const body = gmail.extractBody({
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/html', body: { data: b64('<p>HTML version</p>') } },
        { mimeType: 'text/plain', body: { data: b64('Plain version') } },
      ],
    });
    expect(body).toBe('Plain version');
  });

  it('digs through nested multipart wrappers', () => {
    const body = gmail.extractBody({
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [{ mimeType: 'text/plain', body: { data: b64('Deeply nested') } }],
        },
      ],
    });
    expect(body).toBe('Deeply nested');
  });

  it('falls back to HTML with the tags stripped', () => {
    const body = gmail.extractBody({
      mimeType: 'text/html',
      body: { data: b64('<p>Book me for <b>Tuesday</b></p><br><script>evil()</script>') },
    });
    expect(body).toContain('Book me for Tuesday');
    expect(body).not.toContain('<');
    expect(body).not.toContain('evil()');
  });

  it('decodes HTML entities in the fallback', () => {
    const body = gmail.extractBody({
      mimeType: 'text/html',
      body: { data: b64('<p>Jones &amp; Sons &quot;quoted&quot;&nbsp;text</p>') },
    });
    expect(body).toContain('Jones & Sons "quoted" text');
  });

  it('returns empty string for a message with no readable part', () => {
    expect(gmail.extractBody({ mimeType: 'application/pdf', body: {} })).toBe('');
    expect(gmail.extractBody(null)).toBe('');
  });

  it('builds a well-formed MIME message', () => {
    const mime = gmail.buildMimeMessage({
      to: 'patient@example.com',
      subject: 'Your appointment',
      body: 'See you Tuesday.',
    });

    expect(mime).toContain('To: patient@example.com');
    expect(mime).toContain('Subject: Your appointment');
    expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(mime.endsWith('See you Tuesday.')).toBe(true);
  });

  it('encodes a non-ASCII subject rather than emitting raw bytes', () => {
    const mime = gmail.buildMimeMessage({
      to: 'a@b.com',
      subject: 'Rendez-vous confirmé',
      body: 'x',
    });

    expect(mime).toContain('=?UTF-8?B?');
    expect(mime).not.toContain('Subject: Rendez-vous confirmé');
  });

  describe('API calls', () => {
    beforeEach(async () => {
      const store = await import('../server/services/oauth-store.js');
      store.saveTokens('google', {
        accessToken: 'valid-token',
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    });

    it('narrows the search with Gmail\'s after: operator', async () => {
      const mock = installFetchMock();
      mock.mockResolvedValue(jsonResponse(200, { messages: [{ id: 'm1', threadId: 't1' }] }));

      const result = await gmail.listMessages('label:exam-requests', 1700000000);

      expect(result).toEqual([{ id: 'm1', threadId: 't1' }]);
      const calledUrl = new URL(mock.mock.calls[0][0] as string);
      expect(calledUrl.searchParams.get('q')).toBe('label:exam-requests after:1700000000');
    });

    it('returns an empty list when Gmail reports no matches', async () => {
      const mock = installFetchMock();
      mock.mockResolvedValue(jsonResponse(200, {}));

      expect(await gmail.listMessages('label:none')).toEqual([]);
    });

    it('maps headers and body out of a full message', async () => {
      const mock = installFetchMock();
      mock.mockResolvedValue(
        jsonResponse(200, {
          id: 'm1',
          threadId: 't1',
          internalDate: '1700000000000',
          snippet: 'Booking request',
          payload: {
            headers: [
              { name: 'From', value: 'Ada <ada@example.com>' },
              { name: 'Subject', value: 'Eye exam' },
            ],
            mimeType: 'text/plain',
            body: { data: b64('I would like an exam.') },
          },
        }),
      );

      const msg = await gmail.getMessage('m1');
      expect(msg.from).toBe('Ada <ada@example.com>');
      expect(msg.subject).toBe('Eye exam');
      expect(msg.body).toBe('I would like an exam.');
      expect(msg.receivedAt).toBe(new Date(1700000000000).toISOString());
    });

    it('treats a 401 as a broken connection, not a retryable blip', async () => {
      const mock = installFetchMock();
      mock.mockResolvedValue(jsonResponse(401, { error: 'unauthorized' }));

      await expect(gmail.listMessages('x')).rejects.toMatchObject({
        code: 'not_connected',
        isRetryable: false,
      });
    });

    it('treats a 500 as retryable', async () => {
      const mock = installFetchMock();
      mock.mockResolvedValue(jsonResponse(503, {}));

      await expect(gmail.listMessages('x')).rejects.toMatchObject({
        code: 'server_error',
        isRetryable: true,
      });
    });

    it('sends a message and returns its id', async () => {
      const mock = installFetchMock();
      mock.mockResolvedValue(jsonResponse(200, { id: 'sent-1' }));

      const id = await gmail.sendMessage({
        to: 'patient@example.com',
        subject: 'Reminder',
        body: 'Tomorrow at 10.',
        threadId: 't1',
      });

      expect(id).toBe('sent-1');
      const payload = JSON.parse((mock.mock.calls[0][1] as RequestInit).body as string);
      expect(payload.threadId).toBe('t1');
      expect(Buffer.from(payload.raw, 'base64url').toString()).toContain('To: patient@example.com');
    });
  });
});

describe('matching a request to a calendar event', () => {
  let ctx: TestContext;
  let calendar: typeof import('../server/services/google-calendar.js');

  beforeEach(async () => {
    ctx = await setupTestApp();
    calendar = await import('../server/services/google-calendar.js');
  });
  afterEach(() => ctx.teardown());

  const event = (id: string, startsAt: string, extra: Partial<any> = {}) => ({
    id,
    summary: null,
    description: null,
    location: null,
    startsAt,
    endsAt: null,
    attendeeEmails: [],
    status: 'confirmed',
    ...extra,
  });

  it('matches the single event near the requested time', () => {
    const events = [
      event('a', '2026-09-01T10:00:00Z'),
      event('b', '2026-09-05T10:00:00Z'),
    ];

    const match = calendar.matchEvent(events, { requestedAt: new Date('2026-09-01T10:30:00Z') });
    expect(match?.id).toBe('a');
  });

  it('finds nothing when no event is close enough', () => {
    const events = [event('a', '2026-09-01T10:00:00Z')];

    const match = calendar.matchEvent(events, { requestedAt: new Date('2026-09-01T18:00:00Z') });
    expect(match).toBeUndefined();
  });

  it('disambiguates several nearby events by attendee email', () => {
    const events = [
      event('a', '2026-09-01T10:00:00Z', { attendeeEmails: ['someone@example.com'] }),
      event('b', '2026-09-01T10:15:00Z', { attendeeEmails: ['ada@example.com'] }),
    ];

    const match = calendar.matchEvent(events, {
      requestedAt: new Date('2026-09-01T10:00:00Z'),
      patientEmail: 'ADA@example.com',
    });
    expect(match?.id).toBe('b');
  });

  it('disambiguates by patient name in the event title', () => {
    const events = [
      event('a', '2026-09-01T10:00:00Z', { summary: 'Exam — Bob' }),
      event('b', '2026-09-01T10:15:00Z', { summary: 'Exam — Ada Lovelace' }),
    ];

    const match = calendar.matchEvent(events, {
      requestedAt: new Date('2026-09-01T10:00:00Z'),
      patientName: 'Ada Lovelace',
    });
    expect(match?.id).toBe('b');
  });

  it('refuses to guess between indistinguishable candidates', () => {
    // Attaching an appointment to the wrong patient is worse than asking.
    const events = [
      event('a', '2026-09-01T10:00:00Z'),
      event('b', '2026-09-01T10:15:00Z'),
    ];

    const match = calendar.matchEvent(events, { requestedAt: new Date('2026-09-01T10:00:00Z') });
    expect(match).toBeUndefined();
  });

  it('ignores events with an unparseable start', () => {
    const events = [event('a', '')];
    expect(calendar.matchEvent(events, { requestedAt: new Date('2026-09-01T10:00:00Z') })).toBeUndefined();
  });
});
