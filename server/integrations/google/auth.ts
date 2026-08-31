import { saveTokens, getTokens, isExpired, isConnected, disconnect } from '../../platform/oauth-store.js';
import { audit } from '../../platform/audit.js';
import { endpoint } from '../../platform/endpoints.js';

/**
 * Google OAuth 2.0 (authorization code + refresh).
 *
 * Bare fetch rather than the `googleapis` SDK: this needs three endpoints
 * across Gmail and Calendar, and the SDK is a very large dependency for
 * an app that otherwise calls Anthropic and Wave with plain fetch too.
 *
 * Google permits `http://localhost` redirect URIs, which is what makes
 * this workable for a LAN-only app — the one-time connect happens in a
 * browser on the machine running the server, not from the phone.
 */


export const GOOGLE_SCOPES = [
  // Reminder emails are sent from the business's own mailbox; the app no
  // longer reads the inbox (patient files come from a folder now).
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/userinfo.email',
];

export class GoogleAuthError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'GoogleAuthError';
    this.code = code;
  }

  get isRetryable(): boolean {
    return this.code === 'network_error' || this.code === 'server_error';
  }
}

export function isConfigured(): boolean {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function redirectUri(): string {
  return (
    process.env.GOOGLE_REDIRECT_URI ||
    `http://localhost:${process.env.PORT || 3000}/api/google/callback`
  );
}

function requireCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new GoogleAuthError(
      'not_configured',
      'Google is not configured. Add your OAuth client ID and secret in Settings.',
    );
  }

  return { clientId, clientSecret };
}

/** Builds the consent-screen URL the user is sent to. */
export function buildAuthorizeUrl(state: string): string {
  const { clientId } = requireCredentials();

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    // Google only returns a refresh token with these two together, and
    // only on the first consent — hence 'consent' rather than 'auto',
    // so reconnecting always yields a usable refresh token.
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });

  return `${endpoint('googleAuthorize')}?${params.toString()}`;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

async function postToken(body: URLSearchParams): Promise<TokenResponse> {
  let res: Response;

  try {
    res = await fetch(endpoint('googleToken'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new GoogleAuthError('network_error', `Network error: ${(err as Error).message}`);
  }

  const json = (await res.json().catch(() => ({}))) as TokenResponse;

  if (!res.ok) {
    const detail = json.error_description || json.error || res.statusText;
    // invalid_grant means the refresh token was revoked or expired —
    // reconnecting is the only fix, so it must not look retryable.
    const code = json.error === 'invalid_grant' ? 'invalid_grant' : 'server_error';
    throw new GoogleAuthError(code, `Google OAuth error: ${detail}`);
  }

  if (!json.access_token) {
    throw new GoogleAuthError('invalid_response', 'Google returned no access token.');
  }

  return json;
}

/** Exchanges the callback's `code` for tokens and stores them. */
export async function exchangeCode(code: string): Promise<void> {
  const { clientId, clientSecret } = requireCredentials();

  const json = await postToken(
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri(),
    }),
  );

  const email = await fetchAccountEmail(json.access_token).catch(() => null);

  saveTokens('google', {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? null,
    expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000) : null,
    scope: json.scope ?? null,
    accountLabel: email,
  });

  audit({
    action: 'oauth.connect',
    entityType: 'oauth',
    entityId: 'google',
    detail: email ?? undefined,
  });
}

async function fetchAccountEmail(accessToken: string): Promise<string | null> {
  const res = await fetch(endpoint('googleUserinfo'), {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { email?: string };
  return json.email ?? null;
}

/**
 * Returns a usable access token, refreshing first if it has expired.
 *
 * Every Gmail and Calendar call goes through this rather than reading the
 * stored token directly, so expiry is handled in exactly one place.
 */
export async function getAccessToken(): Promise<string> {
  const tokens = getTokens('google');

  if (!tokens) {
    throw new GoogleAuthError('not_connected', 'Google is not connected. Connect it in Settings.');
  }

  if (!isExpired(tokens)) {
    return tokens.accessToken;
  }

  if (!tokens.refreshToken) {
    throw new GoogleAuthError(
      'not_connected',
      'The Google connection expired and cannot be renewed. Reconnect it in Settings.',
    );
  }

  const { clientId, clientSecret } = requireCredentials();

  const json = await postToken(
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokens.refreshToken,
      grant_type: 'refresh_token',
    }),
  );

  saveTokens('google', {
    accessToken: json.access_token,
    // Omitted on refresh, which saveTokens reads as "keep the existing one".
    refreshToken: json.refresh_token ?? null,
    expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000) : null,
    scope: json.scope ?? tokens.scope,
  });

  return json.access_token;
}

export function isGoogleConnected(): boolean {
  return isConnected('google');
}

export function disconnectGoogle(): void {
  disconnect('google');
}
