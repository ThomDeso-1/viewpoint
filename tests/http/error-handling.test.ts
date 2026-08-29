import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { setupTestApp, type TestContext } from '../helpers/testApp.js';

/**
 * P1-10: the HTTP tail — a JSON 404 for unknown API routes, and a
 * terminal error handler so a handler failure is a 500 rather than a
 * socket that never responds.
 */

describe('HTTP tail', () => {
  let ctx: TestContext;
  afterEach(() => ctx?.teardown());

  it('answers an unknown /api route with a JSON 404, not the SPA shell', async () => {
    ctx = await setupTestApp();

    const res = await request(ctx.app).get('/api/nope/not/here');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body.error).toMatch(/no such endpoint/i);
  });

  it('turns an unguarded handler error into a 500 JSON, not a hang', async () => {
    ctx = await setupTestApp();

    await request(ctx.app).post('/api/auth/setup').send({ password: 'test-password' });
    const login = await request(ctx.app).post('/api/auth/login').send({ password: 'test-password' });
    const token = (login.headers['set-cookie'] as unknown as string[])
      .find((c) => c.startsWith('token='))!
      .split(';')[0]
      .slice('token='.length);

    // A patient whose stored card ciphertext is corrupt: check-eligibility
    // reaches readHealthCard() → decrypt() throws, and the route has no
    // local catch for that path.
    const { getDb } = await import('../../server/db/db.js');
    getDb()
      .prepare(
        `INSERT INTO patients (id, full_name, health_card_enc, created_at, updated_at)
         VALUES ('p-bad', 'Corrupt', 'not-a-real-blob', datetime('now'), datetime('now'))`,
      )
      .run();

    const res = await request(ctx.app)
      .post('/api/exams/patients/p-bad/check-eligibility')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(500);
    expect(res.body.error).toBeTruthy();
    // The generic message — never the underlying decrypt error text.
    expect(JSON.stringify(res.body)).not.toMatch(/malformed|decrypt/i);
  });
});
