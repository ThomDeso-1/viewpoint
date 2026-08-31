import { saveTokens, getTokens, isExpired, isConnected, disconnect } from '../../platform/oauth-store.js';
import { audit } from '../../platform/audit.js';
import { endpoint } from '../../platform/endpoints.js';

/**
 * Microsoft identity platform OAuth 2.0 (authorization code + refresh).
 *
 * Structurally identical to the Google flow in `integrations/google/auth.ts`
 * — bare fetch rather than an SDK, the same encrypted token store, the same
 * shared callback router. It exists so appointment reminders can be sent
 * from an Outlook / Microsoft 365 mailbox instead of Gmail.
 *
 * Like Google, Microsoft permits `http://localhost` redirect URIs, so the
 * one-time connect happens in a browser on the machine running the server.
 */

export const MICROSOFT_SCOPES = [
  // A refresh token is only returned when offline_access is requested.
  'offline_access',
  'https://graph.microsoft.com/Mail.Send',
  'https://graph.microsoft.com/User.Read',
];

export class MicrosoftAuthError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'MicrosoftAuthError';
    this.code = code;
  }

  get isRetryable(): boolean {
    return this.code === 'network_error' || this.code === 'server_error';
  }
}

/** `common` accepts both personal (outlook.com) and work/school accounts. */
export function tenant(): string {
  return process.env.MICROSOFT_TENANT || 'common';
}

export function isConfigured(): boolean {
  return !!(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET);
}

export function redirectUri(): string {
  return (
    process.env.MICROSOFT_REDIRECT_URI ||
    `http://localhost:${process.env.PORT || 3000}/api/microsoft/callback`
  );
}

function requireCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = process.env.MICROSOFT_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new MicrosoftAuthError(
      'not_configured',
      'Microsoft is not configured. Add your app (client) ID and secret in Settings.',
    );
  }

  return { clientId, clientSecret };
}

/** Substitutes the tenant segment the v2.0 authorize/token URLs carry. */
function withTenant(url: string): string {
  return url.replace('{tenant}', tenant());
}

/** Builds the consent-screen URL the user is sent to. */
export function buildAuthorizeUrl(state: string): string {
  const { clientId } = requireCredentials();

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    response_mode: 'query',
    scope: MICROSOFT_SCOPES.join(' '),
    state,
  });

  return `${withTenant(endpoint('microsoftAuthorize'))}?${params.toString()}`;
}

interface TokenResponse {
  access_token?: string;
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
    res = await fetch(withTenant(endpoint('microsoftToken')), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new MicrosoftAuthError('network_error', `Network error: ${(err as Error).message}`);
  }

  const json = (await res.json().catch(() => ({}))) as TokenResponse;

  if (!res.ok) {
    const detail = json.error_description || json.error || res.statusText;
    // invalid_grant means the refresh token was revoked or expired —
    // reconnecting is the only fix, so it must not look retryable.
    const code = json.error === 'invalid_grant' ? 'invalid_grant' : 'server_error';
    throw new MicrosoftAuthError(code, `Microsoft OAuth error: ${detail}`);
  }

  if (!json.access_token) {
    throw new MicrosoftAuthError('invalid_response', 'Microsoft returned no access token.');
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
      scope: MICROSOFT_SCOPES.join(' '),
    }),
  );

  const email = await fetchAccountEmail(json.access_token!).catch(() => null);

  saveTokens('microsoft', {
    accessToken: json.access_token!,
    refreshToken: json.refresh_token ?? null,
    expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000) : null,
    scope: json.scope ?? null,
    accountLabel: email,
  });

  audit({
    action: 'oauth.connect',
    entityType: 'oauth',
    entityId: 'microsoft',
    detail: email ?? undefined,
  });
}

async function fetchAccountEmail(accessToken: string): Promise<string | null> {
  const res = await fetch(`${endpoint('graphBase')}/me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { mail?: string; userPrincipalName?: string };
  return json.mail ?? json.userPrincipalName ?? null;
}

/**
 * Returns a usable access token, refreshing first if it has expired.
 *
 * Every Graph call goes through this rather than reading the stored token
 * directly, so expiry is handled in exactly one place.
 */
export async function getAccessToken(): Promise<string> {
  const tokens = getTokens('microsoft');

  if (!tokens) {
    throw new MicrosoftAuthError('not_connected', 'Microsoft is not connected. Connect it in Settings.');
  }

  if (!isExpired(tokens)) {
    return tokens.accessToken;
  }

  if (!tokens.refreshToken) {
    throw new MicrosoftAuthError(
      'not_connected',
      'The Microsoft connection expired and cannot be renewed. Reconnect it in Settings.',
    );
  }

  const { clientId, clientSecret } = requireCredentials();

  const json = await postToken(
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokens.refreshToken,
      grant_type: 'refresh_token',
      scope: MICROSOFT_SCOPES.join(' '),
    }),
  );

  saveTokens('microsoft', {
    accessToken: json.access_token!,
    // Omitted on refresh, which saveTokens reads as "keep the existing one".
    refreshToken: json.refresh_token ?? null,
    expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000) : null,
    scope: json.scope ?? tokens.scope,
  });

  return json.access_token!;
}

export function isMicrosoftConnected(): boolean {
  return isConnected('microsoft');
}

export function disconnectMicrosoft(): void {
  disconnect('microsoft');
}
