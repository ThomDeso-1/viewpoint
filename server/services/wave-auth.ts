import { saveTokens, getTokens, isExpired, isConnected, disconnect } from './oauth-store.js';
import { audit } from './audit.js';
import { WaveAPIError } from './wave.js';
import { endpoint } from './endpoints.js';

/**
 * Wave authentication, in two interchangeable modes.
 *
 * - `token` (default): the long-lived access token pasted into Settings.
 *   Needs no OAuth app, no Wave Pro subscription, and no public HTTPS
 *   callback — which is why it stays the default for a LAN-only app.
 * - `oauth`: the full authorization-code flow. Wave access tokens expire
 *   after two hours, so this refreshes on demand.
 *
 * Everything that calls Wave goes through getWaveToken(), so the rest of
 * the app never needs to know which mode is active.
 *
 * Note: Wave only permits third-party OAuth against businesses on an
 * active Wave Pro (or Advisors) plan, and requires an HTTPS redirect URI.
 */


export const WAVE_SCOPES = [
  'business:read',
  'account:read',
  'customer:read',
  'customer:write',
  'invoice:read',
  'invoice:write',
  'product:read',
  'sales_tax:read',
  'transaction:read',
  'transaction:write',
];

export type WaveAuthMode = 'token' | 'oauth';

export function authMode(): WaveAuthMode {
  return process.env.WAVE_AUTH_MODE === 'oauth' ? 'oauth' : 'token';
}

export function isOAuthConfigured(): boolean {
  return !!(process.env.WAVE_CLIENT_ID && process.env.WAVE_CLIENT_SECRET);
}

export function redirectUri(): string {
  return (
    process.env.WAVE_REDIRECT_URI ||
    `http://localhost:${process.env.PORT || 3000}/api/wave/callback`
  );
}

function requireCredentials(): { clientId: string; clientSecret: string } {
  const clientId = process.env.WAVE_CLIENT_ID;
  const clientSecret = process.env.WAVE_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new WaveAPIError(
      'not_configured',
      'Wave OAuth is not configured. Add your client ID and secret in Settings.',
    );
  }

  return { clientId, clientSecret };
}

export function buildAuthorizeUrl(state: string): string {
  const { clientId } = requireCredentials();

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: WAVE_SCOPES.join(' '),
    state,
  });

  return `${endpoint('waveAuthorize')}?${params.toString()}`;
}

interface WaveTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
}

async function postToken(body: URLSearchParams): Promise<WaveTokenResponse> {
  let res: Response;

  try {
    res = await fetch(endpoint('waveToken'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new WaveAPIError('network_error', `Network error: ${(err as Error).message}`);
  }

  const json = (await res.json().catch(() => ({}))) as WaveTokenResponse;

  if (!res.ok) {
    const detail = json.error_description || json.error || res.statusText;
    // A revoked or expired refresh token can only be fixed by
    // reconnecting, so it must not be reported as retryable.
    const code = json.error === 'invalid_grant' ? 'invalid_token' : 'server_error';
    throw new WaveAPIError(code, `Wave OAuth error: ${detail}`);
  }

  if (!json.access_token) {
    throw new WaveAPIError('invalid_response', 'Wave returned no access token.');
  }

  return json;
}

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

  saveTokens('wave', {
    accessToken: json.access_token!,
    refreshToken: json.refresh_token ?? null,
    expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000) : null,
    scope: json.scope ?? null,
  });

  audit({ action: 'oauth.connect', entityType: 'oauth', entityId: 'wave' });
}

/**
 * The single source of a usable Wave access token.
 *
 * In token mode this is just the env var, exactly as before. In OAuth
 * mode it refreshes when the two-hour token is at or near expiry.
 */
export async function getWaveToken(): Promise<string> {
  if (authMode() === 'token') {
    const token = process.env.WAVE_ACCESS_TOKEN;
    if (!token) {
      throw new WaveAPIError('no_token', 'Wave is not connected. Add an access token in Settings.');
    }
    return token;
  }

  const tokens = getTokens('wave');
  if (!tokens) {
    throw new WaveAPIError('no_token', 'Wave is not connected. Connect it in Settings.');
  }

  if (!isExpired(tokens)) {
    return tokens.accessToken;
  }

  if (!tokens.refreshToken) {
    throw new WaveAPIError(
      'token_expired',
      'The Wave connection expired and cannot be renewed. Reconnect it in Settings.',
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

  saveTokens('wave', {
    accessToken: json.access_token!,
    refreshToken: json.refresh_token ?? null,
    expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000) : null,
    scope: json.scope ?? tokens.scope,
  });

  return json.access_token!;
}

/**
 * Whether Wave is usable at all right now, without making a network call.
 * Used by the queues to skip work rather than fail it.
 */
export function isWaveConfigured(): boolean {
  return authMode() === 'token' ? !!process.env.WAVE_ACCESS_TOKEN : isConnected('wave');
}

export function disconnectWave(): void {
  disconnect('wave');
}
