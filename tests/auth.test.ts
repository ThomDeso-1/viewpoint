import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { setupTestApp, type TestContext } from './helpers/testApp.js';

/**
 * Spec (GETTING-STARTED.md, server/middleware/auth.ts docblock):
 *  - Before a password is set, the app is in "first-run" state: everything
 *    is open, and the user is prompted to set a password.
 *  - Once a password is set, every /api/* route requires it, either as a
 *    `Bearer <password>` header or a `token` cookie obtained by logging in.
 *  - The same password is used to log in from any device.
 */
describe('authentication', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestApp();
  });

  afterAll(() => ctx.teardown());

  describe('before a password has ever been set', () => {
    it('reports needsSetup on /api/auth/status', async () => {
      const res = await request(ctx.app).get('/api/auth/status');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        authenticated: false,
        needsSetup: true,
        needsOnboarding: false,
      });
    });

    it('leaves normally-protected API routes open (first-run state)', async () => {
      const res = await request(ctx.app).get('/api/receipts');
      expect(res.status).toBe(200);
    });

    it('rejects a password shorter than 4 characters', async () => {
      const res = await request(ctx.app).post('/api/auth/setup').send({ password: 'abc' });
      expect(res.status).toBe(400);
    });

    it('rejects a missing password', async () => {
      const res = await request(ctx.app).post('/api/auth/setup').send({});
      expect(res.status).toBe(400);
    });
  });

  const PASSWORD = 'correct-horse-battery-staple';

  describe('setting the password for the first time', () => {
    it('accepts a valid password and logs the caller in via cookie', async () => {
      const res = await request(ctx.app).post('/api/auth/setup').send({ password: PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
      const setCookie = res.headers['set-cookie'];
      expect(setCookie).toBeDefined();
      expect(setCookie!.some((c: string) => c.startsWith('token='))).toBe(true);
    });

    it('refuses to set the password again once one exists', async () => {
      const res = await request(ctx.app).post('/api/auth/setup').send({ password: 'something-else' });
      expect(res.status).toBe(400);
    });
  });

  describe('after a password is set', () => {
    it('locks down protected routes for unauthenticated requests', async () => {
      const res = await request(ctx.app).get('/api/receipts');
      expect(res.status).toBe(401);
    });

    it('still allows /api/auth/status and /api/auth/login without auth', async () => {
      const status = await request(ctx.app).get('/api/auth/status');
      expect(status.status).toBe(200);

      const badLogin = await request(ctx.app).post('/api/auth/login').send({ password: 'wrong' });
      expect(badLogin.status).toBe(401); // reachable (not 401-from-middleware-gate) but wrong password
    });

    it('rejects login with the wrong password', async () => {
      const res = await request(ctx.app).post('/api/auth/login').send({ password: 'not-it' });
      expect(res.status).toBe(401);
    });

    it('rejects login with a missing password', async () => {
      const res = await request(ctx.app).post('/api/auth/login').send({});
      expect(res.status).toBe(401);
    });

    it('logs in with the correct password and returns an auth cookie', async () => {
      const res = await request(ctx.app).post('/api/auth/login').send({ password: PASSWORD });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
      expect(res.headers['set-cookie']?.some((c: string) => c.startsWith('token='))).toBe(true);
    });

    it('authenticates subsequent requests using the login cookie', async () => {
      const agent = request.agent(ctx.app);
      const login = await agent.post('/api/auth/login').send({ password: PASSWORD });
      expect(login.status).toBe(200);

      const receipts = await agent.get('/api/receipts');
      expect(receipts.status).toBe(200);
    });

    it('authenticates using the password as a Bearer token', async () => {
      const res = await request(ctx.app)
        .get('/api/receipts')
        .set('Authorization', `Bearer ${PASSWORD}`);
      expect(res.status).toBe(200);
    });

    it('rejects an incorrect Bearer token', async () => {
      const res = await request(ctx.app)
        .get('/api/receipts')
        .set('Authorization', 'Bearer nope');
      expect(res.status).toBe(401);
    });

    it('rejects an incorrect cookie', async () => {
      const res = await request(ctx.app).get('/api/receipts').set('Cookie', 'token=wrong-password');
      expect(res.status).toBe(401);
    });

    it('reflects authenticated=true on /api/auth/status once logged in', async () => {
      const res = await request(ctx.app)
        .get('/api/auth/status')
        .set('Authorization', `Bearer ${PASSWORD}`);
      expect(res.status).toBe(200);
      expect(res.body.authenticated).toBe(true);
      expect(res.body.needsSetup).toBe(false);
    });

    it('reports needsOnboarding until /api/settings/onboard is called', async () => {
      const before = await request(ctx.app)
        .get('/api/auth/status')
        .set('Authorization', `Bearer ${PASSWORD}`);
      expect(before.body.needsOnboarding).toBe(true);

      const onboard = await request(ctx.app)
        .post('/api/settings/onboard')
        .set('Authorization', `Bearer ${PASSWORD}`);
      expect(onboard.status).toBe(200);

      const after = await request(ctx.app)
        .get('/api/auth/status')
        .set('Authorization', `Bearer ${PASSWORD}`);
      expect(after.body.needsOnboarding).toBe(false);
    });

    it('logout clears the cookie', async () => {
      const agent = request.agent(ctx.app);
      await agent.post('/api/auth/login').send({ password: PASSWORD });
      expect((await agent.get('/api/receipts')).status).toBe(200);

      const logout = await agent.post('/api/auth/logout');
      expect(logout.status).toBe(200);
      expect(logout.body).toEqual({ success: true });

      // supertest agents drop cookies the server tells them to clear
      const after = await agent.get('/api/receipts');
      expect(after.status).toBe(401);
    });
  });
});

/**
 * Per the auth middleware docblock, an APP_PASSWORD environment variable
 * takes precedence over any password set through the UI/API.
 */
describe('APP_PASSWORD environment override', () => {
  let ctx: TestContext;
  const ENV_PASSWORD = 'env-supplied-password';

  beforeAll(async () => {
    ctx = await setupTestApp({ APP_PASSWORD: ENV_PASSWORD });
  });

  afterAll(() => ctx.teardown());

  it('treats the password as already set', async () => {
    const res = await request(ctx.app).get('/api/auth/status');
    expect(res.body.needsSetup).toBe(false);
  });

  it('refuses first-run setup since a password already exists', async () => {
    const res = await request(ctx.app).post('/api/auth/setup').send({ password: 'whatever1234' });
    expect(res.status).toBe(400);
  });

  it('logs in with the env-supplied password', async () => {
    const res = await request(ctx.app).post('/api/auth/login').send({ password: ENV_PASSWORD });
    expect(res.status).toBe(200);
  });

  it('rejects a password that was never configured', async () => {
    const res = await request(ctx.app).post('/api/auth/login').send({ password: 'some-other-password' });
    expect(res.status).toBe(401);
  });
});
