import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Vitest setup file (vitest.config.ts `setupFiles`). DATA_DIR now resolves
 * against the app folder rather than cwd (server/db/paths.ts), so a test
 * that reached getDb() without setupTestApp() would open the project's
 * real `data/receipts.db`. Point it at a throwaway directory up front;
 * setupTestApp() still overrides it per context.
 */
if (!process.env.DATA_DIR) {
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-test-default-'));
}
