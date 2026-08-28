import { getAccessToken, GoogleAuthError } from './google-auth.js';
import { endpoint } from './endpoints.js';

/**
 * Gmail: reading exam-request emails and sending reminders.
 *
 * Only the three operations the workflow needs — list, get, send.
 */


export interface GmailMessageSummary {
  id: string;
  threadId: string;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  from: string | null;
  to: string | null;
  subject: string | null;
  receivedAt: string;
  snippet: string;
  /** Decoded plain-text body, falling back to a tag-stripped HTML part. */
  body: string;
}

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

/**
 * Lists message ids matching a Gmail search query.
 *
 * `query` is whatever the user configured in Settings (a label, a sender,
 * a subject filter). `afterEpochSeconds` narrows it to messages newer
 * than the last poll, using Gmail's own `after:` operator.
 */
export async function listMessages(
  query: string,
  afterEpochSeconds?: number,
  maxResults = 25,
): Promise<GmailMessageSummary[]> {
  const q = afterEpochSeconds ? `${query} after:${afterEpochSeconds}` : query;

  const params = new URLSearchParams({ q, maxResults: String(maxResults) });
  const json = await gmailFetch(`/messages?${params.toString()}`);

  return (json.messages ?? []).map((m: any) => ({ id: m.id, threadId: m.threadId }));
}

export async function getMessage(id: string): Promise<GmailMessage> {
  const json = await gmailFetch(`/messages/${encodeURIComponent(id)}?format=full`);

  const headers: { name: string; value: string }[] = json.payload?.headers ?? [];
  const header = (name: string): string | null =>
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;

  return {
    id: json.id,
    threadId: json.threadId,
    from: header('From'),
    to: header('To'),
    subject: header('Subject'),
    // internalDate is epoch milliseconds as a string.
    receivedAt: new Date(Number(json.internalDate ?? Date.now())).toISOString(),
    snippet: json.snippet ?? '',
    body: extractBody(json.payload),
  };
}

/**
 * Pulls readable text out of Gmail's nested MIME payload.
 *
 * Prefers text/plain anywhere in the tree; falls back to text/html with
 * tags stripped, since plenty of senders only include an HTML part.
 */
export function extractBody(payload: any): string {
  if (!payload) return '';

  const plain = findPart(payload, 'text/plain');
  if (plain) return decodeBase64Url(plain);

  const html = findPart(payload, 'text/html');
  if (html) return stripHtml(decodeBase64Url(html));

  return '';
}

function findPart(part: any, mimeType: string): string | null {
  if (part.mimeType === mimeType && part.body?.data) {
    return part.body.data;
  }

  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }

  return null;
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface SendMessageOptions {
  to: string;
  subject: string;
  body: string;
  /** Set to reply within the original request's thread. */
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
