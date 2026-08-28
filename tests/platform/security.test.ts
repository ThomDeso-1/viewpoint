import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { setupTestApp, type TestContext } from '../helpers/testApp.js';

/**
 * Covers the hardening added before patient data was introduced:
 * migrations, encryption at rest, scrypt passwords, sessions, login
 * throttling, and authenticated image serving.
 */

const PASSWORD = 'correct-horse-battery-staple';

async function loginForToken(app: TestContext['app'], password = PASSWORD): Promise<string> {
  const res = await request(app).post('/api/auth/login').send({ password });
  expect(res.status).toBe(200);
  const cookies = res.headers['set-cookie'] as unknown as string[];
  return cookies.find((c) => c.startsWith('token='))!.split(';')[0].slice('token='.length);
}

/** Sets a password through the API so the app is past first-run state. */
async function setupPassword(app: TestContext['app']): Promise<void> {
  const res = await request(app).post('/api/auth/setup').send({ password: PASSWORD });
  expect(res.status).toBe(200);
}

describe('schema migrations', () => {
  let ctx: TestContext;
  afterEach(() => ctx?.teardown());

  it('records the applied version and creates the new tables', async () => {
    ctx = await setupTestApp();
    const db = new Database(path.join(ctx.dataDir, 'receipts.db'), { readonly: true });

    const version = db.prepare(`SELECT value FROM app_config WHERE key = 'schema_version'`).get() as
      | { value: string }
      | undefined;
    expect(Number(version?.value)).toBeGreaterThanOrEqual(2);

    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]
    ).map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(['receipts', 'app_config', 'sessions', 'audit_log']));

    db.close();
  });

  it('upgrades a pre-migration database without losing its data', async () => {
    // A v0 install: the original schema.sql tables, no schema_version row.
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-legacy-'));
    const legacyDb = new Database(path.join(legacyDir, 'receipts.db'));
    legacyDb.exec(fs.readFileSync('server/db/migrations/001-initial.sql', 'utf-8'));
    legacyDb
      .prepare(
        `INSERT INTO receipts (id, primary_image, receipt_date, capture_date, month_folder,
                               status, created_at, updated_at)
         VALUES ('old-1', '2026-01/x.jpg', '2026-01-05', '2026-01-05', '2026-01',
                 'uploaded', '2026-01-05', '2026-01-05')`,
      )
      .run();
    legacyDb.close();

    ctx = await setupTestApp({ DATA_DIR: legacyDir });

    const db = new Database(path.join(legacyDir, 'receipts.db'), { readonly: true });
    const survivor = db.prepare(`SELECT id FROM receipts WHERE id = 'old-1'`).get();
    expect(survivor).toBeDefined();

    const sessions = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'`)
      .get();
    expect(sessions).toBeDefined();
    db.close();

    fs.rmSync(legacyDir, { recursive: true, force: true });
  });
});

describe('encryption at rest', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await setupTestApp();
  });
  afterEach(() => ctx.teardown());

  it('round-trips a value and never emits the plaintext', async () => {
    const { encrypt, decrypt } = await import('../../server/platform/crypto.js');
    const secret = '1234567890AB';

    const blob = encrypt(secret);
    expect(blob).not.toContain(secret);
    expect(blob.startsWith('v1:')).toBe(true);
    expect(decrypt(blob)).toBe(secret);
  });

  it('produces a different ciphertext each time (random IV)', async () => {
    const { encrypt, decrypt } = await import('../../server/platform/crypto.js');
    const a = encrypt('same-input');
    const b = encrypt('same-input');
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe(decrypt(b));
  });

  it('rejects a tampered ciphertext rather than returning garbage', async () => {
    const { encrypt, decrypt } = await import('../../server/platform/crypto.js');
    const [v, iv, tag, ct] = encrypt('sensitive').split(':');

    // Flip a byte in the ciphertext; GCM's auth tag should catch it.
    const bytes = Buffer.from(ct, 'base64');
    bytes[0] ^= 0xff;
    expect(() => decrypt([v, iv, tag, bytes.toString('base64')].join(':'))).toThrow();
  });

  it('rejects a malformed blob', async () => {
    const { decrypt } = await import('../../server/platform/crypto.js');
    expect(() => decrypt('not-encrypted')).toThrow(/malformed/i);
  });

  it('persists the generated key to .env so it survives a restart', async () => {
    const { encrypt } = await import('../../server/platform/crypto.js');
    encrypt('anything'); // triggers first-use key generation

    const env = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf-8');
    expect(env).toMatch(/^DATA_ENCRYPTION_KEY=/m);
    expect(process.env.DATA_ENCRYPTION_KEY).toBeTruthy();
  });

  it('passes null through the optional helpers', async () => {
    const { encryptOptional, decryptOptional } = await import('../../server/platform/crypto.js');
    expect(encryptOptional(null)).toBeNull();
    expect(encryptOptional('')).toBeNull();
    expect(decryptOptional(null)).toBeNull();
  });
});

describe('password hashing', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await setupTestApp();
  });
  afterEach(() => ctx.teardown());

  it('stores a salted scrypt hash, not the password or a bare digest', async () => {
    await setupPassword(ctx.app);

    const db = new Database(path.join(ctx.dataDir, 'receipts.db'), { readonly: true });
    const stored = (
      db.prepare(`SELECT value FROM app_config WHERE key = 'password_hash'`).get() as {
        value: string;
      }
    ).value;
    db.close();

    expect(stored.startsWith('scrypt:')).toBe(true);
    expect(stored).not.toContain(PASSWORD);
    expect(stored).not.toBe(crypto.createHash('sha256').update(PASSWORD).digest('hex'));
  });

  it('salts, so the same password hashes differently on two installs', async () => {
    await setupPassword(ctx.app);
    const readHash = (dir: string) => {
      const db = new Database(path.join(dir, 'receipts.db'), { readonly: true });
      const v = (
        db.prepare(`SELECT value FROM app_config WHERE key = 'password_hash'`).get() as {
          value: string;
        }
      ).value;
      db.close();
      return v;
    };
    const first = readHash(ctx.dataDir);

    ctx.teardown();
    ctx = await setupTestApp();
    await setupPassword(ctx.app);

    expect(readHash(ctx.dataDir)).not.toBe(first);
  });

  it('accepts a legacy unsalted SHA-256 hash and upgrades it on login', async () => {
    // Simulate an install created before this change.
    const legacy = crypto.createHash('sha256').update(PASSWORD).digest('hex');
    const write = new Database(path.join(ctx.dataDir, 'receipts.db'));
    write
      .prepare(
        `INSERT INTO app_config (key, value) VALUES ('password_hash', ?)
         ON CONFLICT(key) DO UPDATE SET value = ?`,
      )
      .run(legacy, legacy);
    write.close();

    const login = await request(ctx.app).post('/api/auth/login').send({ password: PASSWORD });
    expect(login.status).toBe(200);

    const read = new Database(path.join(ctx.dataDir, 'receipts.db'), { readonly: true });
    const stored = (
      read.prepare(`SELECT value FROM app_config WHERE key = 'password_hash'`).get() as {
        value: string;
      }
    ).value;
    read.close();

    expect(stored.startsWith('scrypt:')).toBe(true);
    expect(stored).not.toBe(legacy);
  });
});

describe('sessions', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await setupTestApp();
    await setupPassword(ctx.app);
  });
  afterEach(() => ctx.teardown());

  it('stores only a hash of the token, never the token itself', async () => {
    const token = await loginForToken(ctx.app);

    const db = new Database(path.join(ctx.dataDir, 'receipts.db'), { readonly: true });
    const rows = db.prepare(`SELECT token_hash FROM sessions`).all() as { token_hash: string }[];
    db.close();

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.token_hash === token)).toBe(false);
    expect(rows.some((r) => r.token_hash === crypto.createHash('sha256').update(token).digest('hex'))).toBe(
      true,
    );
  });

  it('issues a distinct token per login', async () => {
    expect(await loginForToken(ctx.app)).not.toBe(await loginForToken(ctx.app));
  });

  it('logging out invalidates only that session', async () => {
    const keep = await loginForToken(ctx.app);
    const drop = await loginForToken(ctx.app);

    await request(ctx.app).post('/api/auth/logout').set('Authorization', `Bearer ${drop}`);

    expect((await request(ctx.app).get('/api/receipts').set('Authorization', `Bearer ${drop}`)).status).toBe(
      401,
    );
    expect((await request(ctx.app).get('/api/receipts').set('Authorization', `Bearer ${keep}`)).status).toBe(
      200,
    );
  });

  it('changing the password invalidates every existing session', async () => {
    const oldToken = await loginForToken(ctx.app);

    const change = await request(ctx.app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${oldToken}`)
      .send({ currentPassword: PASSWORD, newPassword: 'a-brand-new-password' });
    expect(change.status).toBe(200);

    expect(
      (await request(ctx.app).get('/api/receipts').set('Authorization', `Bearer ${oldToken}`)).status,
    ).toBe(401);

    const relogin = await request(ctx.app)
      .post('/api/auth/login')
      .send({ password: 'a-brand-new-password' });
    expect(relogin.status).toBe(200);
  });

  it('rejects a change-password with the wrong current password', async () => {
    const token = await loginForToken(ctx.app);
    const res = await request(ctx.app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ currentPassword: 'wrong', newPassword: 'another-password' });
    expect(res.status).toBe(401);
  });
});

describe('login throttling', () => {
  let ctx: TestContext;
  beforeEach(async () => {
    ctx = await setupTestApp();
    await setupPassword(ctx.app);
  });
  afterEach(() => ctx.teardown());

  it('locks out after repeated failures and still refuses the real password', async () => {
    for (let i = 0; i < 10; i++) {
      await request(ctx.app).post('/api/auth/login').send({ password: `guess-${i}` });
    }

    const locked = await request(ctx.app).post('/api/auth/login').send({ password: PASSWORD });
    expect(locked.status).toBe(429);
    expect(locked.headers['retry-after']).toBeDefined();
  });

  it('does not throttle a correct password on the first try', async () => {
    const res = await request(ctx.app).post('/api/auth/login').send({ password: PASSWORD });
    expect(res.status).toBe(200);
  });
});

describe('receipt image access', () => {
  let ctx: TestContext;
  const IMAGE_PATH = '2026-01/receipt.jpg';
  const IMAGE_BYTES = 'fake-jpeg-bytes';

  beforeEach(async () => {
    ctx = await setupTestApp();
    // A real file on disk: a *missing* one falls through express.static to
    // the SPA catch-all and returns index.html with 200, which would make
    // an authorised and an unauthorised hit hard to tell apart.
    const dest = path.join(ctx.dataDir, 'Receipts', IMAGE_PATH);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, IMAGE_BYTES);
  });
  afterEach(() => ctx.teardown());

  it('is open during first-run, before any password is set', async () => {
    const res = await request(ctx.app).get(`/images/${IMAGE_PATH}`);
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe(IMAGE_BYTES);
  });

  it('refuses an anonymous request once a password is set', async () => {
    await setupPassword(ctx.app);

    const res = await request(ctx.app).get(`/images/${IMAGE_PATH}`);
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain(IMAGE_BYTES);
  });

  it('serves the image to an authenticated session', async () => {
    await setupPassword(ctx.app);
    const token = await loginForToken(ctx.app);

    const res = await request(ctx.app)
      .get(`/images/${IMAGE_PATH}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe(IMAGE_BYTES);
  });
});
