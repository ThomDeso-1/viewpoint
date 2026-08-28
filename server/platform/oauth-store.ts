import { getDb } from '../db/db.js';
import type { OAuthProvider, OAuthTokenRow } from '../practice/types.js';
import { encrypt, decrypt, decryptOptional } from './crypto.js';
import { audit } from './audit.js';

/**
 * Encrypted storage for OAuth tokens, shared by Google and Wave.
 *
 * Deliberately not `.env` like the other credentials: these rotate on
 * their own (Wave access tokens last two hours), and rewriting the env
 * file on every refresh would be both noisy and racy.
 */

/** Refresh this far ahead of expiry rather than waiting to be rejected. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

export interface StoredTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scope: string | null;
  accountLabel: string | null;
}

export function saveTokens(
  provider: OAuthProvider,
  tokens: {
    accessToken: string;
    refreshToken?: string | null;
    expiresAt?: Date | null;
    scope?: string | null;
    accountLabel?: string | null;
  },
): void {
  const now = new Date().toISOString();

  // A refresh response often omits refresh_token, meaning "keep the one
  // you have". Overwriting it with null there would silently end the
  // connection at the next expiry.
  const existing = getTokenRow(provider);
  const refreshEnc =
    tokens.refreshToken === undefined || tokens.refreshToken === null
      ? (existing?.refresh_token_enc ?? null)
      : encrypt(tokens.refreshToken);

  getDb()
    .prepare(
      `INSERT INTO oauth_tokens (
         provider, access_token_enc, refresh_token_enc, expires_at, scope,
         account_label, created_at, updated_at
       ) VALUES (
         @provider, @access_token_enc, @refresh_token_enc, @expires_at, @scope,
         @account_label, @created_at, @updated_at
       )
       ON CONFLICT(provider) DO UPDATE SET
         access_token_enc  = excluded.access_token_enc,
         refresh_token_enc = excluded.refresh_token_enc,
         expires_at        = excluded.expires_at,
         scope             = excluded.scope,
         account_label     = excluded.account_label,
         updated_at        = excluded.updated_at`,
    )
    .run({
      provider,
      access_token_enc: encrypt(tokens.accessToken),
      refresh_token_enc: refreshEnc,
      expires_at: tokens.expiresAt ? tokens.expiresAt.toISOString() : null,
      scope: tokens.scope ?? null,
      account_label: tokens.accountLabel ?? existing?.account_label ?? null,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    });
}

function getTokenRow(provider: OAuthProvider): OAuthTokenRow | undefined {
  return getDb().prepare(`SELECT * FROM oauth_tokens WHERE provider = ?`).get(provider) as
    | OAuthTokenRow
    | undefined;
}

export function getTokens(provider: OAuthProvider): StoredTokens | undefined {
  const row = getTokenRow(provider);
  if (!row) return undefined;

  return {
    accessToken: decrypt(row.access_token_enc),
    refreshToken: decryptOptional(row.refresh_token_enc),
    expiresAt: row.expires_at ? new Date(row.expires_at) : null,
    scope: row.scope,
    accountLabel: row.account_label,
  };
}

export function isConnected(provider: OAuthProvider): boolean {
  return !!getTokenRow(provider);
}

/** True when the access token is expired, or close enough that it will be. */
export function isExpired(tokens: StoredTokens): boolean {
  if (!tokens.expiresAt) return false; // no stated expiry — assume usable
  return tokens.expiresAt.getTime() - EXPIRY_SKEW_MS <= Date.now();
}

export function disconnect(provider: OAuthProvider): void {
  getDb().prepare(`DELETE FROM oauth_tokens WHERE provider = ?`).run(provider);
  audit({ action: 'oauth.disconnect', entityType: 'oauth', entityId: provider });
}

/** Connection state for the Settings screen. Never exposes a token. */
export function connectionStatus(provider: OAuthProvider): {
  connected: boolean;
  accountLabel: string | null;
  scope: string | null;
  expiresAt: string | null;
} {
  const row = getTokenRow(provider);
  return {
    connected: !!row,
    accountLabel: row?.account_label ?? null,
    scope: row?.scope ?? null,
    expiresAt: row?.expires_at ?? null,
  };
}
