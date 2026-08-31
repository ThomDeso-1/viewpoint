import express, { Express } from 'express';
// Side-effect: patches the Router so a rejected promise from an async
// handler reaches the error handler instead of hanging the socket.
// Must be imported before any Router is created.
import 'express-async-errors';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './db/db.js';
import { StorageService } from './receipts/storage.js';
import { authMiddleware, requireAuth } from './platform/auth.js';
import { apiNotFound, errorHandler } from './platform/http.js';
import { authRoutes } from './routes/auth.js';
import { receiptRoutes } from './routes/receipts.js';
import { settingsRoutes } from './routes/settings.js';
import { googleRoutes, googleCallbackRoutes } from './routes/google.js';
import { examsRoutes } from './routes/exams.js';
import { waveOAuthRoutes, waveCallbackRoutes } from './routes/wave-oauth.js';
import { microsoftRoutes, microsoftCallbackRoutes } from './routes/microsoft.js';

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

  // Lets req.secure reflect X-Forwarded-Proto from a reverse proxy
  // (deploy/Caddyfile, nginx), which is what decides whether the session
  // cookie is marked Secure. Limited to one hop: the proxy is on the same
  // host, and trusting further would let a client forge the header.
  //
  // Off unless TRUST_PROXY=1. With no proxy in front (the LAN
  // start-native case) a client that reaches the port directly could
  // otherwise forge X-Forwarded-For — which audit_log records — and
  // X-Forwarded-Proto. Set TRUST_PROXY=1 in the same place you set up
  // HTTPS (see docs/DEPLOYMENT.md).
  if (process.env.TRUST_PROXY === '1') {
    app.set('trust proxy', 1);
  }

  // No cors() middleware: the client is always same-origin — proxied
  // through Vite's dev server (client/vite.config.ts) locally, and
  // served from this same Express app in production.
  app.use(express.json());
  app.use(cookieParser());

  // Behind auth: these are photographs of the user's receipts, and were
  // previously served to anyone who could reach the port. Same-origin
  // <img> requests carry the session cookie, so the client is unaffected.
  app.use('/images', requireAuth, express.static(path.join(DATA_DIR, 'Receipts')));

  app.use('/api/auth', authRoutes());

  // Ahead of the auth gate: Google redirects the browser here from
  // accounts.google.com, and the sameSite=strict session cookie is not
  // sent on a cross-site navigation. Protected by its single-use `state`
  // parameter instead — see routes/google.ts.
  app.use('/api/google', googleCallbackRoutes());
  app.use('/api/wave', waveCallbackRoutes());
  app.use('/api/microsoft', microsoftCallbackRoutes());

  app.use('/api', authMiddleware);

  app.use('/api/receipts', receiptRoutes(storage));
  app.use('/api/settings', settingsRoutes());
  app.use('/api/google', googleRoutes());
  app.use('/api/exams', examsRoutes());
  app.use('/api/wave', waveOAuthRoutes());
  app.use('/api/microsoft', microsoftRoutes());

  // Unknown /api endpoint → JSON 404, not the SPA shell.
  app.use('/api', apiNotFound);

  const clientDist = path.join(__dirname, '..', 'client', 'dist');
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'));
  });

  // Terminal error handler — after every route.
  app.use(errorHandler);

  return app;
}
