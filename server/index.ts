import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './db/db.js';
import { StorageService } from './services/storage.js';
import { authMiddleware } from './middleware/auth.js';
import { authRoutes } from './routes/auth.js';
import { receiptRoutes } from './routes/receipts.js';
import { settingsRoutes } from './routes/settings.js';
import { startPolling } from './services/upload-queue.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.DATA_DIR || './data';

// ── Initialize ──
getDb(); // ensure schema is applied
const storage = new StorageService(DATA_DIR);

const app = express();

// ── Middleware ──
app.use(cors());
app.use(express.json());
app.use(cookieParser());

// ── Static: receipt images ──
app.use('/images', express.static(path.join(DATA_DIR, 'Receipts')));

// ── Auth routes (public) ──
app.use('/api/auth', authRoutes());

// ── Auth gate for all other /api routes ──
app.use('/api', authMiddleware);

// ── API routes ──
app.use('/api/receipts', receiptRoutes(storage));
app.use('/api/settings', settingsRoutes());

// ── Serve the React app in production ──
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

// ── Start ──
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Viewpoint Receipts server running on http://0.0.0.0:${PORT}`);
  console.log(`  Data directory: ${path.resolve(DATA_DIR)}`);

  // Start the Wave upload queue (polls every 60s for reviewed receipts)
  startPolling();
  console.log('  Upload queue polling started');
});
