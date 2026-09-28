import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Where the database and its backups live on disk.
 *
 * A relative DATA_DIR (the default is `./data`) is resolved against the
 * app's own folder, not `process.cwd()`. Resolving against cwd meant that
 * starting the server from any other directory silently opened a brand
 * new, empty database there — to the operator, indistinguishable from
 * the real one having been wiped. launchd, `npm run …` and Docker all
 * already run from the app root (or use an absolute path), so for them
 * nothing moves.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** The install root — the folder holding package.json, server/, data/. */
export const APP_ROOT = path.resolve(__dirname, '..', '..');

function resolveFromRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(APP_ROOT, p);
}

/** Absolute DATA_DIR: receipts.db, Receipts/, ohip/, backups/. */
export function resolveDataDir(): string {
  return resolveFromRoot(process.env.DATA_DIR || './data');
}

/**
 * Absolute folder for automatic database snapshots (`backup.ts`).
 *
 * Defaults to `DATA_DIR/backups` so it travels with the data: it is
 * inside the folder `update.sh` preserves, inside the Docker volume, and
 * in the per-test temp directory. Set BACKUP_DIR to put them elsewhere
 * (e.g. an external drive).
 */
export function resolveBackupDir(): string {
  return process.env.BACKUP_DIR
    ? resolveFromRoot(process.env.BACKUP_DIR)
    : path.join(resolveDataDir(), 'backups');
}
