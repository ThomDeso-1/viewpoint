import dotenv from 'dotenv';
import fs from 'fs';

// Same ENV_FILE contract as the server, so re-running the seed sees the
// values a previous run (or the Settings screen) already wrote.
dotenv.config({ path: process.env.ENV_FILE || undefined });
import path from 'path';
import { getDb } from '../server/db/db.js';
import { updateEnvConfig } from '../server/platform/env-config.js';
import { setPassword } from '../server/platform/auth.js';
import { saveTokens } from '../server/platform/oauth-store.js';
import { createPatient, listPatients } from '../server/practice/patients.js';
import { StorageService } from '../server/receipts/storage.js';
import { v4 as uuid } from 'uuid';

/**
 * Prepares a demo database: settings filled in, Google "connected",
 * a couple of patients on file, and some receipts already captured.
 *
 * Idempotent — safe to re-run. `npm run demo:reset` deletes the demo data
 * directory first if you want a genuinely clean slate.
 */

const PASSWORD = process.env.DEMO_PASSWORD || 'demo';

/** A 1×1 PNG, so seeded receipts render as an image rather than a broken one. */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

async function main(): Promise<void> {
  const dataDir = process.env.DATA_DIR || './demo-data';
  fs.mkdirSync(dataDir, { recursive: true });

  getDb(); // applies migrations

  console.log('\n  Seeding demo environment…\n');

  // ── Credentials the demo needs. These are fictional: every one of them
  // is answered by the local mock server, not a real provider. ──
  updateEnvConfig({
    CLAUDE_API_KEY: 'demo-claude-key',

    WAVE_ACCESS_TOKEN: 'demo-wave-token',
    WAVE_BUSINESS_ID: 'demo-business-1',
    WAVE_BUSINESS_NAME: 'Viewpoint Optometry (Demo)',
    WAVE_EXPENSE_ACCOUNT_ID: 'acct-expense-office',
    WAVE_ANCHOR_ACCOUNT_ID: 'acct-bank-chequing',
    WAVE_SALES_TAX_ID: 'tax-hst',
    WAVE_INCOME_ACCOUNT_ID: 'acct-income-fees',

    GOOGLE_CLIENT_ID: 'demo-google-client-id',
    GOOGLE_CLIENT_SECRET: 'demo-google-client-secret',
    GOOGLE_CALENDAR_ID: 'primary',

    GMAIL_EXAM_REQUEST_QUERY: 'label:exam-requests',
    EXAM_REQUEST_MIN_CONFIDENCE: '0.6',
    EXAM_FEE_AMOUNT: '120',

    CLINIC_NAME: 'Viewpoint Optometry',
    CLINIC_TIMEZONE: 'America/Toronto',
    // Higher than the 24h default so the nearest demo appointment's
    // reminder is already due — otherwise you'd wait a day to see one send.
    REMINDER_LEAD_HOURS: '36',

    // Eligibility uses the built-in mock, which labels every result.
    OHIP_HCV_MODE: 'mock',
  });
  console.log('  ✓ settings configured');

  await setPassword(PASSWORD);
  console.log(`  ✓ password set to "${PASSWORD}"`);

  const db = getDb();
  db.prepare(
    `INSERT INTO app_config (key, value) VALUES ('onboarded', 'true')
     ON CONFLICT(key) DO UPDATE SET value = 'true'`,
  ).run();
  console.log('  ✓ onboarding marked complete');

  // Pre-connect Google so the demo doesn't have to walk the consent flow
  // (it still works if you disconnect and reconnect — the mock server
  // auto-approves and the app's real OAuth code runs).
  saveTokens('google', {
    accessToken: 'demo-access-token',
    refreshToken: 'demo-refresh-token',
    expiresAt: new Date(Date.now() + 3600_000),
    scope: 'gmail.readonly gmail.send calendar.events',
    accountLabel: 'reception@viewpoint-demo.example.com',
  });
  console.log('  ✓ Google connected (mock)');

  // ── A couple of existing patients, so matching has something to hit ──
  if (listPatients().length === 0) {
    createPatient({
      full_name: 'Katherine Johnson',
      email: 'katherine.johnson@example.com',
      phone: '(416) 555-0188',
      date_of_birth: '1968-08-26',
      health_card_number: '1111111111',
      health_card_version: 'ZZ',
      notes: 'Existing patient — returning for annual exam.',
    });
    createPatient({
      full_name: 'Mae Jemison',
      email: 'mae.jemison@example.com',
      phone: '(647) 555-0130',
      date_of_birth: '1979-10-17',
      // Deliberately no health card, to show the "needs a card" path.
      notes: 'Health card not yet on file.',
    });
    console.log('  ✓ 2 existing patients created');
  } else {
    console.log('  · patients already present, left alone');
  }

  // ── A few captured receipts, so that side of the app isn't empty ──
  const receiptCount = (db.prepare('SELECT COUNT(*) as n FROM receipts').get() as { n: number }).n;
  if (receiptCount === 0) {
    const storage = new StorageService(dataDir);
    const now = new Date();

    for (let i = 0; i < 3; i++) {
      const date = new Date(now.getTime() - i * 86_400_000);
      const { primaryPath } = storage.saveReceiptImages(
        [{ buffer: TINY_PNG, mimetype: 'image/png' }],
        date,
      );

      db.prepare(
        `INSERT INTO receipts (
           id, primary_image, additional_images, receipt_date, capture_date,
           month_folder, status, image_hash, created_at, updated_at
         ) VALUES (@id, @primary_image, '[]', @receipt_date, @capture_date,
           @month_folder, 'captured', @image_hash, @created_at, @updated_at)`,
      ).run({
        id: uuid(),
        primary_image: primaryPath,
        receipt_date: date.toISOString(),
        capture_date: date.toISOString(),
        month_folder: storage.monthFolder(date),
        image_hash: storage.computeImageHash(primaryPath),
        created_at: date.toISOString(),
        updated_at: date.toISOString(),
      });
    }
    console.log('  ✓ 3 receipts captured (tap one to extract)');
  } else {
    console.log('  · receipts already present, left alone');
  }

  console.log(`\n  Demo data lives in ${path.resolve(dataDir)}\n`);
}

main().catch((err) => {
  console.error('\n  Seeding failed:', err.message, '\n');
  process.exit(1);
});
