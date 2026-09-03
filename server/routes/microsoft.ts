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
import { createPkcePair } from '../integrations/oauth/pkce.js';
import { makeCallbackRouter } from '../integrations/oauth/callback.js';

/**
 * Microsoft sign-in — one consent that grants identity, mail send, and
 * calendar access from an Outlook / Microsoft 365 account. Runs as a
 * public client (authorization code + PKCE, no secret); the state store,
 * callback router and result page are all shared (`integrations/oauth/`).
 *
 * The app ships with its application (client) ID, so `POST /credentials`
 * is only for pointing a deployment at a different registration.
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

  // ── POST /api/microsoft/credentials — point at a different app registration ──
  router.post('/credentials', (req: Request, res: Response): void => {
    const { clientId, tenant } = req.body;

    if (!clientId || typeof clientId !== 'string') {
      res.status(400).json({ error: 'A Microsoft application (client) ID is required.' });
      return;
    }

    updateEnvConfig({
      MICROSOFT_CLIENT_ID: clientId.trim(),
      ...(tenant ? { MICROSOFT_TENANT: String(tenant).trim() } : {}),
    });

    res.json({ success: true, redirectUri: redirectUri() });
  });

  // ── GET /api/microsoft/connect — start the consent flow ──
  router.get('/connect', (_req: Request, res: Response): void => {
    if (!isConfigured()) {
      res.status(400).json({
        error: 'Microsoft is not set up. Add an application (client) ID first.',
      });
      return;
    }

    const { verifier, challenge } = createPkcePair();
    res.redirect(buildAuthorizeUrl(issueState({ verifier }), challenge));
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
    exchange: (code, state) => exchangeCode(code, state.verifier),
    describeError: (err) =>
      err instanceof MicrosoftAuthError ? err.message : `Unexpected error: ${(err as Error).message}`,
  });
}
