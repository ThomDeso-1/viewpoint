import { Router, Request, Response } from 'express';
import {
  buildAuthorizeUrl,
  exchangeCode,
  isOAuthConfigured,
  redirectUri,
  authMode,
  disconnectWave,
} from '../integrations/wave/auth.js';
import { connectionStatus } from '../platform/oauth-store.js';
import { updateEnvConfig } from '../platform/env-config.js';
import { issueState } from '../integrations/oauth/state-store.js';
import { makeCallbackRouter } from '../integrations/oauth/callback.js';
import { WaveAPIError } from '../integrations/wave/index.js';

/**
 * Wave OAuth, structurally identical to the Microsoft flow in
 * routes/microsoft.ts — the state store, the callback router, and the
 * result page are all shared (integrations/oauth/).
 *
 * OAuth is the alternative to the pasted access token, not a replacement:
 * Wave only allows third-party OAuth against businesses on an active Wave
 * Pro plan, and requires an HTTPS redirect URI. Token mode stays the
 * default (see integrations/wave/auth.ts).
 */

export function waveOAuthRoutes(): Router {
  const router = Router();

  router.get('/status', (_req: Request, res: Response): void => {
    res.json({
      mode: authMode(),
      configured: isOAuthConfigured(),
      redirectUri: redirectUri(),
      ...connectionStatus('wave'),
    });
  });

  router.post('/credentials', (req: Request, res: Response): void => {
    const { clientId, clientSecret } = req.body;

    if (!clientId || typeof clientId !== 'string' || !clientSecret || typeof clientSecret !== 'string') {
      res.status(400).json({ error: 'A Wave client ID and secret are both required.' });
      return;
    }

    updateEnvConfig({
      WAVE_CLIENT_ID: clientId.trim(),
      WAVE_CLIENT_SECRET: clientSecret.trim(),
    });

    res.json({ success: true, redirectUri: redirectUri() });
  });

  /** Switches between the pasted token and OAuth. */
  router.post('/mode', (req: Request, res: Response): void => {
    const { mode } = req.body;

    if (mode !== 'token' && mode !== 'oauth') {
      res.status(400).json({ error: 'Mode must be "token" or "oauth".' });
      return;
    }

    if (mode === 'oauth' && !isOAuthConfigured()) {
      res.status(400).json({ error: 'Save your Wave OAuth client ID and secret first.' });
      return;
    }

    updateEnvConfig({ WAVE_AUTH_MODE: mode });
    res.json({ success: true, mode });
  });

  router.get('/connect', (_req: Request, res: Response): void => {
    if (!isOAuthConfigured()) {
      res.status(400).json({ error: 'Wave OAuth is not configured. Save a client ID and secret first.' });
      return;
    }

    res.redirect(buildAuthorizeUrl(issueState()));
  });

  router.post('/disconnect', (_req: Request, res: Response): void => {
    disconnectWave();
    res.json({ success: true });
  });

  return router;
}

/** The callback, mounted ahead of the auth gate. */
export function waveCallbackRoutes(): Router {
  return makeCallbackRouter({
    name: 'Wave',
    exchange: exchangeCode,
    describeError: (err) =>
      err instanceof WaveAPIError ? err.message : `Unexpected error: ${(err as Error).message}`,
  });
}
