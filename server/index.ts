import dotenv from 'dotenv';
import path from 'path';

// Must run before anything reads process.env. ENV_FILE lets the demo
// runner keep its configuration in demo-data/.env instead of the real
// one — env-config.ts writes to the same path, so reads and writes stay
// on the same file.
dotenv.config({ path: process.env.ENV_FILE || undefined });
import { createApp } from './app.js';
import { startPolling } from './services/upload-queue.js';
import { startPolling as startPracticePolling } from './services/practice-queue.js';
import { warnIfDemoMode } from './services/endpoints.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.DATA_DIR || './data';

const app = createApp();

app.listen(PORT, '0.0.0.0', () => {
  warnIfDemoMode();
  console.log(`Viewpoint Receipts server running on http://0.0.0.0:${PORT}`);
  console.log(`  Data directory: ${path.resolve(DATA_DIR)}`);

  // Both pollers are started here rather than inside createApp() so that
  // tests, which build the app directly, never spawn background timers.
  startPolling();
  console.log('  Upload queue polling started');

  startPracticePolling();
  console.log('  Practice queue polling started');
});
