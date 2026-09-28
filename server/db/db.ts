import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveDataDir } from './paths.js';
import { hasUserTables, snapshotDatabase } from './backup.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let db: Database.Database;
let dbInfo: { path: string; createdNow: boolean } | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  const dataDir = resolveDataDir();
  fs.mkdirSync(dataDir, { recursive: true });

  const dbPath = path.join(dataDir, 'receipts.db');
  const createdNow = !fs.existsSync(dbPath);
  db = new Database(dbPath);
  dbInfo = { path: dbPath, createdNow };
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  runMigrations(db);

  return db;
}

/**
 * Closes the connection and clears the singleton.
 *
 * Production never needs this — the process owning the database exits
 * with it. Tests do: each one opens its own database in a temp directory
 * and then deletes that directory, and without closing first the handles
 * (three per database, in WAL mode) accumulate for the whole run until
 * the process runs out of file descriptors and unrelated tests start
 * failing at random.
 */
export function closeDb(): void {
  if (!db) return;
  try {
    db.close();
  } catch {
    // Already closed, or the file is gone — nothing useful to do.
  }
  db = undefined as unknown as Database.Database;
  dbInfo = null;
}

/**
 * Where the open database lives, and whether this process created it.
 * `index.ts` prints a loud warning for a new file: on an install that has
 * been in use, a fresh database means the server was pointed at the wrong
 * DATA_DIR — the real one is still sitting wherever it was.
 */
export function databaseInfo(): { path: string; createdNow: boolean } {
  getDb();
  return dbInfo!;
}

// ── Migrations ──

/**
 * Applies `db/migrations/NNN-*.sql` in filename order, once each.
 *
 * Replaces the previous approach of re-`exec`ing a single schema.sql on
 * every boot: `CREATE TABLE IF NOT EXISTS` can create a table but can
 * never add a column to one, so there was no way to evolve the schema.
 *
 * The applied number lives in app_config under `schema_version`. Existing
 * installs sit at version 0 with the receipts tables already present —
 * 001 is the original schema verbatim and is a no-op for them, so they
 * pick up 002 onward without any special-casing.
 */
function runMigrations(conn: Database.Database): void {
  // Bootstrap the table the version marker itself lives in. 001 also
  // creates it (IF NOT EXISTS), which is why this is safe to do first.
  conn.exec(`CREATE TABLE IF NOT EXISTS app_config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);

  const row = conn
    .prepare(`SELECT value FROM app_config WHERE key = 'schema_version'`)
    .get() as { value: string } | undefined;
  const currentVersion = row ? parseInt(row.value, 10) : 0;

  const dir = path.join(__dirname, 'migrations');
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const setVersion = conn.prepare(
    `INSERT INTO app_config (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = ?`,
  );

  const pending = files.filter((file) => {
    const version = parseInt(file.slice(0, 3), 10);
    if (Number.isNaN(version)) {
      throw new Error(`Migration filename must start with a 3-digit number: ${file}`);
    }
    return version > currentVersion;
  });

  // Snapshot an existing database before any migration touches it, so a
  // migration that turns out to be destructive (a table rebuild like 005,
  // a mistaken DELETE) can be undone. A brand-new database has nothing to
  // lose and is skipped. If the snapshot itself fails, the throw stops the
  // boot before anything is migrated.
  if (pending.length > 0 && hasUserTables(conn)) {
    snapshotDatabase(conn, `pre-migration-${pending[0].slice(0, 3)}`);
  }

  for (const file of pending) {
    const version = parseInt(file.slice(0, 3), 10);

    const sql = fs.readFileSync(path.join(dir, file), 'utf-8');

    // Each migration and its version bump land together or not at all, so
    // a failure part-way through can't leave a half-applied schema that
    // the next boot would skip over.
    conn.transaction(() => {
      conn.exec(sql);
      setVersion.run(String(version), String(version));
    })();
  }
}

// ── Receipt types ──

export interface ReceiptRow {
  id: string;
  primary_image: string;
  additional_images: string; // JSON array
  receipt_date: string;
  capture_date: string;
  month_folder: string;
  status: string;
  vendor: string | null;
  summary: string | null;
  total_amount: number | null;
  tax_amount: number | null;
  currency: string;
  extracted_json: string | null;
  /** Historical only — set on receipts posted before the Wave queue was removed (migration 010). */
  wave_txn_id: string | null;
  last_error: string | null;
  retry_count: number;
  image_hash: string | null;
  /** Claude's 'high' | 'medium' | 'low'; null until extracted. */
  confidence: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * captured → extracted → reviewed, or captured → needsAttention when the
 * image can't be read. `reviewed` is "operator checked it", not a gate —
 * nothing downstream waits on it (migration 010).
 */
export type ReceiptStatus = 'captured' | 'extracted' | 'reviewed' | 'needsAttention';

// ── Config helpers ──

export function getConfig(key: string): string | undefined {
  const row = getDb().prepare('SELECT value FROM app_config WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setConfig(key: string, value: string): void {
  getDb()
    .prepare('INSERT INTO app_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?')
    .run(key, value, value);
}
