import { Router, Request, Response } from 'express';
import { consumeState, type StateData } from './state-store.js';
import { escapeHtml } from '../../platform/escape.js';

/**
 * The shared OAuth callback router, mounted ahead of the auth gate.
 *
 * It cannot be session-authenticated: the session cookie is
 * `sameSite: strict`, so the browser does not send it on the top-level
 * navigation back from accounts.google.com / api.waveapps.com. The
 * single-use `state` secret protects it instead — which is what state is
 * for — and every other OAuth route stays behind the normal auth gate.
 *
 * Google, Wave and Microsoft differ only in their `buildAuthorizeUrl` /
 * `exchange` and the error class they throw; everything below — state
 * handling, the result page, the status codes — was byte-for-byte
 * identical between the route files (audit P2-25).
 */

export interface CallbackProvider {
  /** Display name, e.g. "Google" or "Microsoft". */
  name: string;
  /**
   * Exchanges the callback's `code` for tokens and stores them. `state`
   * carries whatever `issueState` stashed — the PKCE `verifier` for the
   * Microsoft public-client flow; unused by Google and Wave.
   */
  exchange: (code: string, state: StateData) => Promise<void>;
  /** Turns a thrown exchange error into a user-facing message. */
  describeError: (err: unknown) => string;
}

export function makeCallbackRouter(provider: CallbackProvider): Router {
  const router = Router();

  router.get('/callback', async (req: Request, res: Response): Promise<void> => {
    const { code, state, error } = req.query;

    if (error) {
      res
        .status(400)
        .send(page(provider.name, false, `${provider.name} returned an error: ${String(error)}`));
      return;
    }

    const stateData = consumeState(typeof state === 'string' ? state : undefined);
    if (!stateData) {
      res
        .status(400)
        .send(page(provider.name, false, 'This sign-in link has expired or was already used. Try again from Settings.'));
      return;
    }

    if (!code || typeof code !== 'string') {
      res
        .status(400)
        .send(page(provider.name, false, `${provider.name} did not return an authorization code.`));
      return;
    }

    try {
      await provider.exchange(code, stateData);
      res.send(page(provider.name, true, `${provider.name} is connected. You can close this tab.`));
    } catch (err) {
      res.status(502).send(page(provider.name, false, provider.describeError(err)));
    }
  });

  return router;
}

/**
 * A self-contained result page. This tab is opened by the provider's
 * redirect and is not the app's SPA, so it cannot rely on any client
 * bundle.
 */
function page(provider: string, ok: boolean, message: string): string {
  const escaped = escapeHtml(message);

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
      <h1>${ok ? `${provider} connected` : 'Connection failed'}</h1>
      <p>${escaped}</p>
      ${ok ? '' : '<p style="margin-top:1rem"><a href="/settings">Back to Settings</a></p>'}
    </div>
  </body>
</html>`;
}
