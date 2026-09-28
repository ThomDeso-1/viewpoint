import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { setupTestApp, type TestContext } from '../helpers/testApp.js';

/**
 * Spec (AGENTS.md §2 "Database safety"): the local database must not be
 * clearable by accident. Covers the four ways it could be:
 *   - a relative DATA_DIR resolved against the wrong cwd → a fresh empty DB
 *   - a lost / swapped .env → a new encryption key → unreadable data
 *   - a destructive migration → no way back
 *   - no routine copies at all
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function legacyDbDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const legacy = new Database(path.join(dir, 'receipts.db'));
  legacy.exec(fs.readFileSync(path.join(REPO_ROOT, 'server/db/migrations/001-initial.sql'), 'utf-8'));
  legacy
    .prepare(
      `INSERT INTO receipts (id, primary_image, receipt_date, capture_date, month_folder,
                             status, created_at, updated_at)
       VALUES ('keep-me', 'x.jpg', '2026-01-05', '2026-01-05', '2026-01',
               'extracted', '2026-01-05', '2026-01-05')`,
    )
    .run();
  legacy.close();
  return dir;
}

function backupsIn(dir: string): string[] {
  const b = path.join(dir, 'backups');
  return fs.existsSync(b) ? fs.readdirSync(b).sort() : [];
}

describe('DATA_DIR resolution', () => {
  const saved = { DATA_DIR: process.env.DATA_DIR, BACKUP_DIR: process.env.BACKUP_DIR, cwd: process.cwd() };
  afterEach(() => {
    process.env.DATA_DIR = saved.DATA_DIR;
    if (saved.BACKUP_DIR === undefined) delete process.env.BACKUP_DIR;
    else process.env.BACKUP_DIR = saved.BACKUP_DIR;
    process.chdir(saved.cwd);
  });

  it('resolves a relative DATA_DIR against the app folder, not the current directory', async () => {
    const { resolveDataDir, resolveBackupDir, APP_ROOT } = await import('../../server/db/paths.js');
    expect(APP_ROOT).toBe(REPO_ROOT);

    process.chdir(os.tmpdir());
    process.env.DATA_DIR = './data';
    expect(resolveDataDir()).toBe(path.join(REPO_ROOT, 'data'));
    expect(resolveBackupDir()).toBe(path.join(REPO_ROOT, 'data', 'backups'));

    process.env.DATA_DIR = '/abs/elsewhere';
    expect(resolveDataDir()).toBe('/abs/elsewhere');
    process.env.BACKUP_DIR = '/Volumes/External/vp';
    expect(resolveBackupDir()).toBe('/Volumes/External/vp');
  });
});

describe('pre-migration snapshot', () => {
  let ctx: TestContext;
  afterEach(() => ctx?.teardown());

  it('copies an existing database aside before migrating it', async () => {
    const dir = legacyDbDir('vr-premig-');
    ctx = await setupTestApp({ DATA_DIR: dir });

    const snaps = backupsIn(dir);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatch(/^receipts-pre-migration-001-.*\.db$/);

    // The snapshot is the database as it was *before* migrating.
    const snap = new Database(path.join(dir, 'backups', snaps[0]), { readonly: true });
    expect(snap.prepare(`SELECT id FROM receipts`).all()).toEqual([{ id: 'keep-me' }]);
    expect(snap.prepare(`SELECT value FROM app_config WHERE key = 'schema_version'`).get()).toBeUndefined();
    snap.close();
  });

  it('does not snapshot a brand-new database', async () => {
    ctx = await setupTestApp();
    expect(backupsIn(ctx.dataDir)).toEqual([]);
  });

  it('does not snapshot again when nothing is pending', async () => {
    const dir = legacyDbDir('vr-premig2-');
    ctx = await setupTestApp({ DATA_DIR: dir });
    const { closeDb, getDb } = await import('../../server/db/db.js');
    closeDb();
    getDb(); // reopen: already at the latest version
    expect(backupsIn(dir)).toHaveLength(1);
  });
});

describe('daily snapshots', () => {
  let ctx: TestContext;
  afterEach(() => ctx?.teardown());

  it('takes one when due, skips when recent, and prunes only old daily files', async () => {
    ctx = await setupTestApp();
    const { getDb } = await import('../../server/db/db.js');
    const { runDailyBackupIfDue, DAILY_KEEP } = await import('../../server/db/backup.js');
    const db = getDb();
    const dir = path.join(ctx.dataDir, 'backups');

    const first = runDailyBackupIfDue(db);
    expect(first).toMatch(/receipts-daily-.*\.db$/);
    expect(runDailyBackupIfDue(db)).toBeNull();

    // Age it plus a pile of older dailies, and add files that must survive.
    const old = Date.now() / 1000 - 3 * 24 * 3600;
    fs.utimesSync(first!, old, old);
    for (let i = 0; i < DAILY_KEEP + 5; i++) {
      const f = path.join(dir, `receipts-daily-2020-01-${String(i).padStart(2, '0')}.db`);
      fs.writeFileSync(f, '');
      fs.utimesSync(f, old - (i + 1) * 3600, old - (i + 1) * 3600);
    }
    fs.writeFileSync(path.join(dir, 'receipts-pre-migration-011-x.db'), '');
    fs.writeFileSync(path.join(dir, 'receipts-pre-update-x.db'), '');
    fs.writeFileSync(path.join(dir, 'operator-copy.db'), '');

    const second = runDailyBackupIfDue(db);
    expect(second).not.toBeNull();

    const files = fs.readdirSync(dir);
    expect(files.filter((f) => f.startsWith('receipts-daily-'))).toHaveLength(DAILY_KEEP);
    expect(files).toContain(path.basename(second!));
    expect(files).toEqual(
      expect.arrayContaining(['receipts-pre-migration-011-x.db', 'receipts-pre-update-x.db', 'operator-copy.db']),
    );

    // A snapshot is a real, readable copy of the live database.
    const snap = new Database(second!, { readonly: true });
    expect(snap.prepare(`SELECT value FROM app_config WHERE key = 'schema_version'`).get()).toBeDefined();
    snap.close();
  });
});

describe('encryption key guard', () => {
  let ctx: TestContext;
  afterEach(() => ctx?.teardown());

  it('refuses to mint a new key when .env loses the one the database uses', async () => {
    ctx = await setupTestApp();
    const crypto = await import('../../server/platform/crypto.js');
    const blob = crypto.encrypt('ON-1234567890'); // generates + fingerprints the key
    const originalKey = process.env.DATA_ENCRYPTION_KEY!;
    const envBefore = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf-8');

    // .env lost
    crypto.resetKeyCache();
    delete process.env.DATA_ENCRYPTION_KEY;
    expect(() => crypto.getEncryptionKey()).toThrow(/missing from \.env/);
    expect(process.env.DATA_ENCRYPTION_KEY).toBeUndefined();
    expect(fs.readFileSync(path.join(process.cwd(), '.env'), 'utf-8')).toBe(envBefore);

    // wrong .env
    crypto.resetKeyCache();
    process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
    expect(() => crypto.verifyEncryptionKey()).toThrow(/not the key this database was encrypted with/);

    // restored
    crypto.resetKeyCache();
    process.env.DATA_ENCRYPTION_KEY = originalKey;
    expect(crypto.decrypt(blob)).toBe('ON-1234567890');
  });

  it('protects databases that were encrypted before fingerprints existed', async () => {
    ctx = await setupTestApp();
    const { getDb } = await import('../../server/db/db.js');
    const crypto = await import('../../server/platform/crypto.js');
    const db = getDb();
    db.exec(`CREATE TABLE legacy_secret (thing_enc TEXT)`);
    db.prepare(`INSERT INTO legacy_secret VALUES ('v1:a:b:c')`).run();

    expect(() => crypto.getEncryptionKey()).toThrow(/missing from \.env/);
    expect(process.env.DATA_ENCRYPTION_KEY).toBeUndefined();
  });

  it('records a fingerprint for an existing key on first use', async () => {
    const key = Buffer.alloc(32, 3).toString('base64');
    ctx = await setupTestApp({ DATA_ENCRYPTION_KEY: key });
    const { getConfig } = await import('../../server/db/db.js');
    const crypto = await import('../../server/platform/crypto.js');
    expect(getConfig('encryption_key_fingerprint')).toBeUndefined();
    crypto.verifyEncryptionKey();
    expect(getConfig('encryption_key_fingerprint')).toMatch(/^[0-9a-f]{64}$/);
    expect(getConfig('encryption_key_fingerprint')).not.toContain(key);
  });
});

describe('.env writes', () => {
  let ctx: TestContext;
  afterEach(() => ctx?.teardown());

  it('replaces the file atomically and leaves no temp file behind', async () => {
    ctx = await setupTestApp();
    const { updateEnvConfig } = await import('../../server/platform/env-config.js');
    updateEnvConfig({ BUSINESS_NAME: 'A' });
    updateEnvConfig({ BUSINESS_NAME: 'B', PORT: '3000' });
    const files = fs.readdirSync(process.cwd());
    expect(files.filter((f) => f.startsWith('.env'))).toEqual(['.env']);
    expect(fs.readFileSync('.env', 'utf-8')).toBe('BUSINESS_NAME=B\nPORT=3000\n');
    expect(fs.statSync('.env').mode & 0o777).toBe(0o600);
  });
});

describe('migration guard', () => {
  /**
   * Migrations up to 010 predate this rule and are frozen. Any later one
   * that deletes rows or drops a table/column must say why, in a
   * `-- destructive-ok: <reason>` comment, so it gets a second look in
   * review. (Every migration is also snapshotted before it runs — see
   * runMigrations.)
   */
  it('new migrations do not delete data without an explicit destructive-ok note', () => {
    const dir = path.join(REPO_ROOT, 'server/db/migrations');
    const offenders = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.sql') && parseInt(f.slice(0, 3), 10) > 10)
      .filter((f) => {
        const sql = fs.readFileSync(path.join(dir, f), 'utf-8');
        const code = sql.replace(/--.*$/gm, '');
        const destructive = /\b(DROP\s+TABLE|DROP\s+COLUMN|DELETE\s+FROM|TRUNCATE)\b/i.test(code);
        return destructive && !/--\s*destructive-ok:\s*\S/.test(sql);
      });
    expect(offenders).toEqual([]);
  });
});
