import { Router, Request, Response } from 'express';
import {
  buildAuthorizeUrl,
  exchangeCode,
  isConfigured,
  redirectUri,
  disconnectGoogle,
  GoogleAuthError,
} from '../integrations/google/auth.js';
import { connectionStatus } from '../platform/oauth-store.js';
import { updateEnvConfig } from '../platform/env-config.js';
import { issueState } from '../integrations/oauth/state-store.js';
import { makeCallbackRouter } from '../integrations/oauth/callback.js';

/**
 * Google connect/disconnect.
 *
 * The OAuth callback is split into its own router (`googleCallbackRoutes`)
 * because it cannot be session-authenticated — see
 * `integrations/oauth/callback.ts` for why. The state store and the
 * result page are shared with the Wave flow.
 */

/** Routes requiring a logged-in session. */
export function googleRoutes(): Router {
  const router = Router();

  // ── GET /api/google/status ──
  router.get('/status', (_req: Request, res: Response): void => {
    res.json({
      configured: isConfigured(),
      redirectUri: redirectUri(),
      ...connectionStatus('google'),
    });
  });

  // ── POST /api/google/credentials — save the OAuth client ──
  router.post('/credentials', (req: Request, res: Response): void => {
    const { clientId, clientSecret, calendarId } = req.body;

    if (!clientId || typeof clientId !== 'string') {
      res.status(400).json({ error: 'A Google OAuth client ID is required.' });
      return;
    }
    if (!clientSecret || typeof clientSecret !== 'string') {
      res.status(400).json({ error: 'A Google OAuth client secret is required.' });
      return;
    }

    updateEnvConfig({
      GOOGLE_CLIENT_ID: clientId.trim(),
      GOOGLE_CLIENT_SECRET: clientSecret.trim(),
      ...(calendarId ? { GOOGLE_CALENDAR_ID: String(calendarId).trim() } : {}),
    });

    res.json({ success: true, redirectUri: redirectUri() });
  });

  // ── GET /api/google/connect — start the consent flow ──
  router.get('/connect', (_req: Request, res: Response): void => {
    if (!isConfigured()) {
      res.status(400).json({
        error: 'Google is not configured. Save your OAuth client ID and secret first.',
      });
      return;
    }

    res.redirect(buildAuthorizeUrl(issueState()));
  });

  // ── POST /api/google/disconnect ──
  router.post('/disconnect', (_req: Request, res: Response): void => {
    disconnectGoogle();
    res.json({ success: true });
  });

  return router;
}

/** The OAuth callback, mounted ahead of the auth gate. */
export function googleCallbackRoutes(): Router {
  return makeCallbackRouter({
    name: 'Google',
    exchange: exchangeCode,
    describeError: (err) =>
      err instanceof GoogleAuthError ? err.message : `Unexpected error: ${(err as Error).message}`,
  });
}
