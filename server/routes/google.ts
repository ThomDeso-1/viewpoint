import { Router, Request, Response } from 'express';
import crypto from 'crypto';
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

/**
 * Google connect/disconnect.
 *
 * Split into two routers because the OAuth callback cannot be
 * session-authenticated: the session cookie is `sameSite: strict`, so the
 * browser does not send it on a top-level navigation from
 * accounts.google.com. The callback is protected by the single-use
 * `state` secret instead — which is what state is for — and everything
 * else sits behind the normal auth gate.
 */

const STATE_TTL_MS = 10 * 60 * 1000;

/** Pending authorize attempts, by state token. Single-use and expiring. */
const pendingStates = new Map<string, number>();

function issueState(): string {
  pruneStates();
  const state = crypto.randomBytes(32).toString('base64url');
  pendingStates.set(state, Date.now() + STATE_TTL_MS);
  return state;
}

function consumeState(state: string | undefined): boolean {
  pruneStates();
  if (!state || !pendingStates.has(state)) return false;
  pendingStates.delete(state); // single use
  return true;
}

function pruneStates(): void {
  const now = Date.now();
  for (const [state, expiry] of pendingStates) {
    if (expiry <= now) pendingStates.delete(state);
  }
}

/** Test seam — module-level state outlives an app instance. */
export function resetPendingStates(): void {
  pendingStates.clear();
}

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

/**
 * The OAuth callback, mounted ahead of the auth gate. See the note above
 * for why this cannot require a session.
 */
export function googleCallbackRoutes(): Router {
  const router = Router();

  router.get('/callback', async (req: Request, res: Response): Promise<void> => {
    const { code, state, error } = req.query;

    if (error) {
      res.status(400).send(renderResult(false, `Google returned an error: ${String(error)}`));
      return;
    }

    // Rejecting an unknown state is what stops an attacker from feeding
    // us an authorization code from their own account.
    if (!consumeState(typeof state === 'string' ? state : undefined)) {
      res
        .status(400)
        .send(renderResult(false, 'This sign-in link has expired or was already used. Try again from Settings.'));
      return;
    }

    if (!code || typeof code !== 'string') {
      res.status(400).send(renderResult(false, 'Google did not return an authorization code.'));
      return;
    }

    try {
      await exchangeCode(code);
      res.send(renderResult(true, 'Google is connected. You can close this tab.'));
    } catch (err) {
      const message =
        err instanceof GoogleAuthError ? err.message : `Unexpected error: ${(err as Error).message}`;
      res.status(502).send(renderResult(false, message));
    }
  });

  return router;
}

/**
 * A self-contained result page. This tab is opened by Google's redirect
 * and is not the app's SPA, so it cannot rely on any client bundle.
 */
function renderResult(ok: boolean, message: string): string {
  const escaped = message.replace(/[&<>"']/g, (c) => {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return map[c];
  });

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${ok ? 'Connected' : 'Connection failed'}</title>
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
             background: #1a2332; color: #f4f6fb; display: grid; place-items: center;
             min-height: 100vh; margin: 0; padding: 1.5rem; }
      .card { max-width: 26rem; text-align: center; background: #22304a;
              border-radius: 0.75rem; padding: 2rem; }
      .icon { font-size: 2.5rem; }
      h1 { font-size: 1.25rem; margin: 0.75rem 0 0.5rem; }
      p { margin: 0; color: #b8c4dc; line-height: 1.5; }
      a { color: #7aa7ff; }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="icon">${ok ? '✅' : '⚠️'}</div>
      <h1>${ok ? 'Google connected' : 'Connection failed'}</h1>
      <p>${escaped}</p>
      ${ok ? '' : '<p style="margin-top:1rem"><a href="/settings">Back to Settings</a></p>'}
    </div>
  </body>
</html>`;
}
