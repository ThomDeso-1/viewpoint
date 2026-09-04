import { saveTokens, getTokens, isExpired, isConnected, disconnect } from '../../platform/oauth-store.js';
import { audit } from '../../platform/audit.js';
import { endpoint } from '../../platform/endpoints.js';
import { ApiError } from '../../platform/api-error.js';

/**
 * Microsoft identity platform OAuth 2.0 — authorization code + PKCE,
 * running as a **public client**.
 *
 * The app ships with its own registered application (client) ID and no
 * secret: a desktop install cannot keep a secret secret, and Azure's
 * "Mobile and desktop applications" platform is built for exactly this.
 * PKCE (`integrations/oauth/pkce.ts`) stands in for the secret — the
 * `code_verifier` is minted with the `state`, held server-side, and sent
 * only on the token exchange.
 *
 * Dropping the secret also removes the setup foot-guns that came with it:
 * nothing to mis-copy from the portal ("Value" vs "Secret ID"), nothing
 * to expire, and no confidential-client / SPA platform mismatch.
 *
 * Microsoft permits `http://localhost` redirect URIs, so the one-time
 * sign-in happens in a browser on the machine running the server.
 */

export const MICROSOFT_SCOPES = [
  // A refresh token is only returned when offline_access is requested.
  'offline_access',
  // Identity — so the one button is both "sign in" and "grant access".
  'openid',
  'profile',
  'https://graph.microsoft.com/User.Read',
  // Sending appointment reminders from the business mailbox.
  'https://graph.microsoft.com/Mail.Send',
  // Reading and writing the appointment calendar (Phase 1+).
  'https://graph.microsoft.com/Calendars.ReadWrite',
];

export class MicrosoftAuthError extends ApiError {
  /** From Graph's `Retry-After` on a 429 — how long to back off before trying again. */
  retryAfterMs?: number;

  constructor(code: string, message: string, retryAfterMs?: number) {
    super('MicrosoftAuthError', code, message);
    this.retryAfterMs = retryAfterMs;
  }
}

/** `common` accepts both personal (outlook.com) and work/school accounts. */
export function tenant(): string {
  return process.env.MICROSOFT_TENANT || 'common';
}

/**
 * The application (client) ID. Shipped in the deploy's `.env` for this
 * clinic's registration — non-secret, so safe to distribute — or pasted
 * once from Settings.
 */
export function clientId(): string {
  return process.env.MICROSOFT_CLIENT_ID || '';
}

export function isConfigured(): boolean {
  return !!clientId();
}

export function redirectUri(): string {
  return (
    process.env.MICROSOFT_REDIRECT_URI ||
    `http://localhost:${process.env.PORT || 3000}/api/microsoft/callback`
  );
}

function requireClientId(): string {
  const id = clientId();
  if (!id) {
    throw new MicrosoftAuthError(
      'not_configured',
      'Microsoft is not set up. Add your application (client) ID in Settings.',
    );
  }
  return id;
}

/** Substitutes the tenant segment the v2.0 authorize/token URLs carry. */
function withTenant(url: string): string {
  return url.replace('{tenant}', tenant());
}

/**
 * Builds the consent-screen URL the user is sent to. `codeChallenge` is
 * the S256 hash of the verifier held against this flow's `state`.
 */
export function buildAuthorizeUrl(state: string, codeChallenge: string): string {
  const params = new URLSearchParams({
    client_id: requireClientId(),
    redirect_uri: redirectUri(),
    response_type: 'code',
    response_mode: 'query',
    scope: MICROSOFT_SCOPES.join(' '),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
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

/**
 * Exchanges the callback's `code` for tokens and stores them. `verifier`
 * is the PKCE `code_verifier` stashed with the `state`.
 */
export async function exchangeCode(code: string, verifier: string | undefined): Promise<void> {
  if (!verifier) {
    throw new MicrosoftAuthError(
      'invalid_response',
      'This sign-in link is missing its security check. Start again from Settings.',
    );
  }

  const json = await postToken(
    new URLSearchParams({
      client_id: requireClientId(),
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri(),
      code_verifier: verifier,
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
 * directly, so expiry is handled in exactly one place. Microsoft rotates
 * the refresh token on every use for public clients; `saveTokens` writes
 * the new one each time it is present.
 */
export async function getAccessToken(): Promise<string> {
  const tokens = getTokens('microsoft');

  if (!tokens) {
    throw new MicrosoftAuthError('not_connected', 'Microsoft is not connected. Sign in from Settings.');
  }

  if (!isExpired(tokens)) {
    return tokens.accessToken;
  }

  if (!tokens.refreshToken) {
    throw new MicrosoftAuthError(
      'not_connected',
      'The Microsoft connection expired and cannot be renewed. Sign in again from Settings.',
    );
  }

  const json = await postToken(
    new URLSearchParams({
      client_id: requireClientId(),
      refresh_token: tokens.refreshToken,
      grant_type: 'refresh_token',
      scope: MICROSOFT_SCOPES.join(' '),
    }),
  );

  saveTokens('microsoft', {
    accessToken: json.access_token!,
    // Public-client refresh tokens are single-use and rotated; store the
    // replacement. Omitted only if Microsoft unexpectedly doesn't send one,
    // which saveTokens reads as "keep the existing one".
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
