import crypto from 'crypto';
import { getDb } from '../db/db.js';

/**
 * Session tokens.
 *
 * Replaces the previous scheme where the login cookie *was* the plaintext
 * password: that meant the password travelled on every single request and
 * had to be re-hashed to verify each one. With scrypt now behind the
 * password (deliberately slow), that would also have made every request
 * cost ~100ms and turned any unauthenticated endpoint into a CPU
 * amplification vector.
 *
 * A session is a random 32-byte secret. Only its SHA-256 is stored, so the
 * database file alone can't be turned into a valid cookie.
 */

const TOKEN_BYTES = 32;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const SESSION_COOKIE = 'token';

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Mints a session and returns the raw token — the only time it exists. */
export function createSession(userAgent?: string): { token: string; expiresAt: Date } {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

  getDb()
    .prepare(
      `INSERT INTO sessions (token_hash, created_at, expires_at, last_seen_at, user_agent)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      hashToken(token),
      now.toISOString(),
      expiresAt.toISOString(),
      now.toISOString(),
      userAgent ?? null,
    );

  // Opportunistic cleanup — no cron needed for a single-user app.
  pruneExpiredSessions();

  return { token, expiresAt };
}

/** True if the token maps to a live session. Refreshes last_seen_at. */
export function verifySession(token: string): boolean {
  if (!token) return false;

  const db = getDb();
  const row = db
    .prepare(`SELECT expires_at FROM sessions WHERE token_hash = ?`)
    .get(hashToken(token)) as { expires_at: string } | undefined;

  if (!row) return false;

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    destroySession(token);
    return false;
  }

  db.prepare(`UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?`).run(
    new Date().toISOString(),
    hashToken(token),
  );

  return true;
}

export function destroySession(token: string): void {
  getDb().prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(hashToken(token));
}

/** Invalidates every session — used when the password changes. */
export function destroyAllSessions(): void {
  getDb().prepare(`DELETE FROM sessions`).run();
}

export function pruneExpiredSessions(): void {
  getDb().prepare(`DELETE FROM sessions WHERE expires_at <= ?`).run(new Date().toISOString());
}

const BASE_COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: 'strict' as const,
  maxAge: SESSION_TTL_MS,
};

/**
 * Cookie options for this request.
 *
 * `secure` is set whenever the connection actually is HTTPS — directly,
 * or via a reverse proxy's X-Forwarded-Proto (Express populates req.secure
 * from it once `trust proxy` is enabled, which app.ts does).
 *
 * It cannot be unconditional: the app is commonly reached over plain HTTP
 * on a LAN, and a Secure cookie would simply never be stored there,
 * locking the user out. Deciding per-request means turning on HTTPS
 * upgrades the cookie automatically, with nothing to remember.
 */
export function sessionCookieOptions(req: { secure?: boolean }): typeof BASE_COOKIE_OPTIONS & {
  secure: boolean;
} {
  return { ...BASE_COOKIE_OPTIONS, secure: !!req.secure };
}
