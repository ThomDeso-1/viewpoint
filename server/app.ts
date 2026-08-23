import express, { Express } from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './db/db.js';
import { StorageService } from './services/storage.js';
import { authMiddleware } from './middleware/auth.js';
import { authRoutes } from './routes/auth.js';
import { receiptRoutes } from './routes/receipts.js';
import { settingsRoutes } from './routes/settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Builds the Express app (routes, middleware, static serving) without
 * starting the HTTP listener or the background upload-queue poller.
 * Used by both the production entrypoint (index.ts) and tests.
 */
export function createApp(): Express {
  const DATA_DIR = process.env.DATA_DIR || './data';

  getDb(); // ensure schema is applied
  const storage = new StorageService(DATA_DIR);

  const app = express();

  // No cors() middleware: the client is always same-origin — proxied
  // through Vite's dev server (client/vite.config.ts) locally, and
  // served from this same Express app in production.
  app.use(express.json());
  app.use(cookieParser());

  app.use('/images', express.static(path.join(DATA_DIR, 'Receipts')));

  app.use('/api/auth', authRoutes());

  app.use('/api', authMiddleware);

  app.use('/api/receipts', receiptRoutes(storage));
  app.use('/api/settings', settingsRoutes());

  const clientDist = path.join(__dirname, '..', 'client', 'dist');
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });

  return app;
}
