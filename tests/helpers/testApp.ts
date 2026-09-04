import fs from 'fs';
import http from 'http';
import { once } from 'events';
import os from 'os';
import path from 'path';
import { vi } from 'vitest';

const CREDENTIAL_ENV_KEYS = [
  'APP_PASSWORD',
  'CLAUDE_API_KEY',
  'WAVE_ACCESS_TOKEN',
  'WAVE_BUSINESS_ID',
  'WAVE_BUSINESS_NAME',
  'WAVE_EXPENSE_ACCOUNT_ID',
  'WAVE_ANCHOR_ACCOUNT_ID',
  'WAVE_SALES_TAX_ID',
  // Generated on first use rather than pasted in. Without clearing it,
  // the first test to trigger generation leaks its key into every later
  // test, which then reuses it instead of writing its own .env.
  'DATA_ENCRYPTION_KEY',
  'MICROSOFT_CLIENT_ID',
  'MICROSOFT_CLIENT_SECRET',
  'MICROSOFT_REDIRECT_URI',
  'MICROSOFT_TENANT',
  'MICROSOFT_CALENDAR_ID',
  'EXAM_REQUEST_SOURCE_DIR',
  'EXAM_REQUEST_SOURCE_MAX_FILE_MB',
  'EXAM_REQUEST_MIN_CONFIDENCE',
  'WAVE_AUTH_MODE',
  'WAVE_CLIENT_ID',
  'WAVE_CLIENT_SECRET',
  'WAVE_INCOME_ACCOUNT_ID',
  'WAVE_SERVICE_PRODUCT_ID',
  'EXAM_FEE_AMOUNT',
  'OHIP_ENABLED',
  'OHIP_HCV_MODE',
  'OHIP_PRIVATE_KEY_PATH',
  'OHIP_CERTIFICATE_PATH',
  'OHIP_CA_CERT_PATH',
  'OHIP_USERNAME',
  'OHIP_PASSWORD',
  'OHIP_MOH_ID',
  'OHIP_CONFORMANCE_KEY',
  'BUSINESS_NAME',
  'REMINDER_LEAD_HOURS',
  'DEMO_MODE',
  'DEMO_API_BASE',
  'TRUST_PROXY',
  'APP_PUBLIC_URL',
  'ALLOW_INSECURE_PHI',
];

/** Deletes every credential-related env var so tests start from a clean slate. */
export function clearCredentialEnv(): void {
  for (const key of CREDENTIAL_ENV_KEYS) {
    delete process.env[key];
  }
}

export interface TestContext {
  /**
   * A real HTTP server listening on an ephemeral port, kept up for the
   * life of the context. `supertest(ctx.app)` reuses it instead of
   * spinning up (and tearing down) a fresh server per request — the
   * churn that lets superagent's keep-alive pool hand a request a socket
   * whose server has just closed, surfacing as an intermittent
   * "socket hang up". `http.Server` satisfies supertest's `App` type.
   */
  app: http.Server;
  dataDir: string;
  /** Restores cwd and removes the temp directories. Call in afterAll. */
  teardown: () => void;
}

/**
 * Builds a fresh app backed by an isolated temp data directory and an
 * isolated temp working directory (so anything that writes to `.env`
 * relative to process.cwd() never touches the real project's .env).
 *
 * Import `createApp` dynamically (after env is set up) so each test file's
 * fresh module registry re-reads DATA_DIR / cwd at the right time.
 */
export async function setupTestApp(envOverrides: Record<string, string> = {}): Promise<TestContext> {
  const originalCwd = process.cwd();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-test-data-'));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-test-cwd-'));

  clearCredentialEnv();
  process.env.DATA_DIR = dataDir;
  for (const [k, v] of Object.entries(envOverrides)) {
    process.env[k] = v;
  }
  process.chdir(workDir);

  // Node's ESM cache is per-specifier for the life of the process/worker,
  // so a second setupTestApp() call in the same test file would otherwise
  // reuse the previous call's already-initialized DB connection and
  // module-level caches (e.g. the settings health-check cache) instead of
  // getting a clean slate. Force a fresh module graph every time.
  vi.resetModules();
  const { createApp } = await import('../../server/app.js');
  // Same module registry as the app just built, so this closes the very
  // connection it opened rather than a fresh one.
  const { closeDb } = await import('../../server/db/db.js');
  const app = createApp();

  // One listening server per context, closed in teardown(). Await the
  // 'listening' event so supertest sees an already-bound server
  // (app.address() truthy) and reuses it rather than calling listen(0)
  // itself.
  const server = http.createServer(app);
  server.listen(0);
  await once(server, 'listening');

  return {
    app: server,
    dataDir,
    teardown: () => {
      // Drop any lingering keep-alive sockets before close() so the
      // handle is released now rather than after keepAliveTimeout.
      server.closeAllConnections();
      server.close();
      // Close before deleting the directory: an open SQLite handle in WAL
      // mode keeps file descriptors alive, and with ~200 tests each
      // opening one, the process eventually exhausts them and unrelated
      // tests start failing at random.
      closeDb();
      process.chdir(originalCwd);
      clearCredentialEnv();
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(workDir, { recursive: true, force: true });
    },
  };
}

/** Fake image bytes — the app hashes/stores bytes, it never decodes them. */
export function fakeImageBytes(seed = 'x'): Buffer {
  return Buffer.from(`fake-image-bytes-${seed}-${'a'.repeat(32)}`);
}
