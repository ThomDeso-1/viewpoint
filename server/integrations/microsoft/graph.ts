import { graphFetch } from './client.js';
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
 *
 * The shared fetch wrapper (auth header, timeout, status taxonomy) lives
 * in `client.ts`.
 */

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
