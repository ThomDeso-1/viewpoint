import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Express } from 'express';
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
];

/** Deletes every credential-related env var so tests start from a clean slate. */
export function clearCredentialEnv(): void {
  for (const key of CREDENTIAL_ENV_KEYS) {
    delete process.env[key];
  }
}

export interface TestContext {
  app: Express;
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
  const app = createApp();

  return {
    app,
    dataDir,
    teardown: () => {
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
