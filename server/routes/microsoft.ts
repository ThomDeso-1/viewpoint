import { Router, Request, Response } from 'express';
import {
  buildAuthorizeUrl,
  exchangeCode,
  isConfigured,
  redirectUri,
  disconnectMicrosoft,
  MicrosoftAuthError,
} from '../integrations/microsoft/auth.js';
import { connectionStatus } from '../platform/oauth-store.js';
import { updateEnvConfig } from '../platform/env-config.js';
import { issueState } from '../integrations/oauth/state-store.js';
import { makeCallbackRouter } from '../integrations/oauth/callback.js';

/**
 * Microsoft connect/disconnect — the Outlook / Microsoft 365 alternative to
 * Gmail for sending reminder emails. Structurally identical to
 * `routes/google.ts`; the state store, callback router, and result page are
 * all shared (`integrations/oauth/`).
 */

/** Routes requiring a logged-in session. */
export function microsoftRoutes(): Router {
  const router = Router();

  // ── GET /api/microsoft/status ──
  router.get('/status', (_req: Request, res: Response): void => {
    res.json({
      configured: isConfigured(),
      redirectUri: redirectUri(),
      ...connectionStatus('microsoft'),
    });
  });

  // ── POST /api/microsoft/credentials — save the OAuth client ──
  router.post('/credentials', (req: Request, res: Response): void => {
    const { clientId, clientSecret, tenant } = req.body;

    if (!clientId || typeof clientId !== 'string') {
      res.status(400).json({ error: 'A Microsoft application (client) ID is required.' });
      return;
    }
    if (!clientSecret || typeof clientSecret !== 'string') {
      res.status(400).json({ error: 'A Microsoft client secret is required.' });
      return;
    }

    updateEnvConfig({
      MICROSOFT_CLIENT_ID: clientId.trim(),
      MICROSOFT_CLIENT_SECRET: clientSecret.trim(),
      ...(tenant ? { MICROSOFT_TENANT: String(tenant).trim() } : {}),
    });

    res.json({ success: true, redirectUri: redirectUri() });
  });

  // ── GET /api/microsoft/connect — start the consent flow ──
  router.get('/connect', (_req: Request, res: Response): void => {
    if (!isConfigured()) {
      res.status(400).json({
        error: 'Microsoft is not configured. Save your application ID and secret first.',
      });
      return;
    }

    res.redirect(buildAuthorizeUrl(issueState()));
  });

  // ── POST /api/microsoft/disconnect ──
  router.post('/disconnect', (_req: Request, res: Response): void => {
    disconnectMicrosoft();
    res.json({ success: true });
  });

  return router;
}

/** The OAuth callback, mounted ahead of the auth gate. */
export function microsoftCallbackRoutes(): Router {
  return makeCallbackRouter({
    name: 'Microsoft',
    exchange: exchangeCode,
    describeError: (err) =>
      err instanceof MicrosoftAuthError ? err.message : `Unexpected error: ${(err as Error).message}`,
  });
}
