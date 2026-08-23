import 'dotenv/config';
import path from 'path';
import { createApp } from './app.js';
import { startPolling } from './services/upload-queue.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.DATA_DIR || './data';

const app = createApp();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Viewpoint Receipts server running on http://0.0.0.0:${PORT}`);
  console.log(`  Data directory: ${path.resolve(DATA_DIR)}`);

  // Start the Wave upload queue (polls every 60s for reviewed receipts)
  startPolling();
  console.log('  Upload queue polling started');
});
