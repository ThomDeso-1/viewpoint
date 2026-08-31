import { getAccessToken, GoogleAuthError } from './auth.js';
import { endpoint } from '../../platform/endpoints.js';

/**
 * Gmail: sending appointment reminders.
 *
 * The app used to read exam-request emails here too; patient files now
 * come from a scanned folder (`exams/file-source.ts`), so this is
 * send-only — one operation, from the business's own mailbox.
 */

async function gmailFetch(pathAndQuery: string, init: RequestInit = {}): Promise<any> {
  const token = await getAccessToken();

  let res: Response;
  try {
    res = await fetch(`${endpoint('gmailBase')}${pathAndQuery}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new GoogleAuthError('network_error', `Network error: ${(err as Error).message}`);
  }

  if (res.status === 401) {
    throw new GoogleAuthError('not_connected', 'Google rejected the stored credentials. Reconnect in Settings.');
  }

  if (res.status === 429 || res.status >= 500) {
    throw new GoogleAuthError('server_error', `Gmail API error (${res.status}): ${res.statusText}`);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new GoogleAuthError('bad_request', `Gmail API error (${res.status}): ${detail}`);
  }

  return res.json();
}

export interface SendMessageOptions {
  to: string;
  subject: string;
  body: string;
  /** Set to reply within an existing thread. */
  threadId?: string | null;
}

/** Sends a plain-text email. Returns Gmail's id for the sent message. */
export async function sendMessage(opts: SendMessageOptions): Promise<string> {
  const mime = buildMimeMessage(opts);

  const json = await gmailFetch('/messages/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      raw: Buffer.from(mime).toString('base64url'),
      ...(opts.threadId ? { threadId: opts.threadId } : {}),
    }),
  });

  return json.id;
}

export function buildMimeMessage(opts: SendMessageOptions): string {
  // RFC 2047 encoded-word, so accented names and the like survive a
  // subject line intact.
  const subject = /^[\x20-\x7E]*$/.test(opts.subject)
    ? opts.subject
    : `=?UTF-8?B?${Buffer.from(opts.subject).toString('base64')}?=`;

  return [
    `To: ${opts.to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    opts.body,
  ].join('\r\n');
}
