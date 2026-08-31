import { getAccessToken, MicrosoftAuthError } from './auth.js';
import { endpoint } from '../../platform/endpoints.js';
import type { SendMessageOptions } from '../google/gmail.js';

/**
 * Microsoft Graph: sending appointment reminders from an Outlook /
 * Microsoft 365 mailbox.
 *
 * Send-only, mirroring `integrations/google/gmail.ts` — one operation,
 * from the business's own mailbox. Graph's `sendMail` takes a JSON message
 * (no MIME assembly) and returns `202 Accepted` with an empty body, so
 * there is no provider message id to return; the caller only stores it for
 * reference, so a synthesised marker is enough.
 */

async function graphFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAccessToken();

  let res: Response;
  try {
    res = await fetch(`${endpoint('graphBase')}${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new MicrosoftAuthError('network_error', `Network error: ${(err as Error).message}`);
  }

  if (res.status === 401) {
    throw new MicrosoftAuthError('not_connected', 'Microsoft rejected the stored credentials. Reconnect in Settings.');
  }

  if (res.status === 429 || res.status >= 500) {
    throw new MicrosoftAuthError('server_error', `Graph API error (${res.status}): ${res.statusText}`);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new MicrosoftAuthError('bad_request', `Graph API error (${res.status}): ${detail}`);
  }

  return res;
}

/** Sends a plain-text email. Returns a synthesised reference id. */
export async function sendMail(opts: SendMessageOptions): Promise<string> {
  await graphFetch('/me/sendMail', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        subject: opts.subject,
        body: { contentType: 'Text', content: opts.body },
        toRecipients: [{ emailAddress: { address: opts.to } }],
      },
      saveToSentItems: true,
    }),
  });

  return `graph-${Date.now()}`;
}
