import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { resolveBackupDir } from './paths.js';

/**
 * Automatic database snapshots — the safety net against the database
 * being cleared or damaged by accident (a bad migration, a botched
 * update, a restore gone wrong).
 *
 * Snapshots are taken with `VACUUM INTO`, which writes a consistent,
 * self-contained copy of the live database (WAL contents included) while
 * the server keeps running — unlike copying `receipts.db`, which misses
 * whatever is still in the `-wal` file. It is synchronous, so the
 * pre-migration snapshot can run inside the synchronous migration runner.
 *
 * Three kinds, told apart by filename:
 *   receipts-daily-<ts>.db             every 24h while the server runs; the newest DAILY_KEEP kept
 *   receipts-pre-migration-NNN-<ts>.db before a schema migration touches an existing database; never pruned
 *   receipts-pre-update-<ts>.db        written by scripts/update.sh; never pruned
 *
 * Snapshots hold the same encrypted blobs as the live file, so they need
 * the same DATA_ENCRYPTION_KEY from `.env` to be useful — back that up
 * separately (audit P2-7).
 *
 * To restore: stop the server, copy the snapshot over `DATA_DIR/receipts.db`,
 * delete any `receipts.db-wal` / `receipts.db-shm` beside it, start again.
 */

const DAILY_PREFIX = 'receipts-daily-';
const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
export const DAILY_KEEP = 30;

function timestamp(now: Date): string {
  // 2026-09-27T22-01-05-123Z — sortable, filename-safe, unique per ms.
  return now.toISOString().replace(/[:.]/g, '-');
}

/**
 * Writes a snapshot of `conn` into the backup folder and returns its path.
 * `label` becomes part of the filename (`receipts-<label>-<ts>.db`).
 */
export function snapshotDatabase(conn: Database.Database, label: string, now = new Date()): string {
  const dir = resolveBackupDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const dest = path.join(dir, `receipts-${label}-${timestamp(now)}.db`);
  conn.prepare('VACUUM INTO ?').run(dest);
  fs.chmodSync(dest, 0o600);
  return dest;
}

/** True if the database holds any table beyond the bootstrap app_config — i.e. it is not brand new. */
export function hasUserTables(conn: Database.Database): boolean {
  const row = conn
    .prepare(
      `SELECT 1 FROM sqlite_master
        WHERE type = 'table' AND name NOT IN ('app_config') AND name NOT LIKE 'sqlite_%'
        LIMIT 1`,
    )
    .get();
  return row !== undefined;
}

function listDaily(dir: string): { file: string; mtimeMs: number }[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(DAILY_PREFIX) && f.endsWith('.db'))
    .map((f) => ({ file: path.join(dir, f), mtimeMs: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Takes a daily snapshot if the newest one is ≥24h old (or there is none),
 * then prunes daily snapshots beyond DAILY_KEEP. Only `receipts-daily-*`
 * files are ever deleted — pre-migration / pre-update snapshots and
 * anything the operator put in the folder are left alone.
 *
 * Returns the new snapshot's path, or null if one wasn't due.
 */
export function runDailyBackupIfDue(conn: Database.Database, now = new Date()): string | null {
  const dir = resolveBackupDir();
  const newest = listDaily(dir)[0];
  if (newest && now.getTime() - newest.mtimeMs < DAILY_INTERVAL_MS) return null;

  const created = snapshotDatabase(conn, 'daily', now);
  for (const old of listDaily(dir).slice(DAILY_KEEP)) {
    fs.unlinkSync(old.file);
  }
  return created;
}

/**
 * Checks hourly (and once now) whether a daily snapshot is due. Hourly
 * rather than a 24h timer so a Mac that sleeps or restarts still gets one
 * a day. Started only from `server/index.ts`, like the queue pollers.
 * A failed backup is logged and retried next hour — it never takes the
 * server down.
 */
export function startBackupSchedule(conn: Database.Database): void {
  const tick = () => {
    try {
      const created = runDailyBackupIfDue(conn);
      if (created) console.log(`[backup] Database snapshot written: ${created}`);
    } catch (err) {
      console.error('[backup] Daily database snapshot failed:', err);
    }
  };
  tick();
  setInterval(tick, CHECK_INTERVAL_MS).unref();
}
