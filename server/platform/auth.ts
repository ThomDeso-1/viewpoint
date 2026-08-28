import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { promisify } from 'util';
import { getConfig, setConfig } from '../db/db.js';
import { verifySession } from './sessions.js';

/**
 * Single-user auth.
 *
 * On first run the user sets a password via POST /api/auth/setup. Logging
 * in mints a session token (see services/sessions.ts) which is what the
 * `token` cookie — or an `Authorization: Bearer` header — carries from
 * then on. The password itself is never used as a credential after login.
 *
 * Passwords are hashed with scrypt and a per-password salt. The previous
 * unsalted single-round SHA-256 hashes are still accepted once and
 * transparently re-hashed on the next successful login, so upgrading the
 * app doesn't lock anyone out.
 */

const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;
const SCRYPT_PREFIX = 'scrypt';

// Node's defaults (N=16384, r=8, p=1) — recorded explicitly because they
// are baked into every stored hash and must not drift.
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };

/**
 * Async by design. scrypt is deliberately expensive — roughly 100ms of
 * solid CPU — and the synchronous variant would block the event loop for
 * that long on every login, stalling every other in-flight request.
 */
const scryptAsync = promisify(crypto.scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

function scryptHash(password: string, salt: Buffer): Promise<Buffer> {
  return scryptAsync(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
}

/** Formats as `scrypt:<saltB64>:<hashB64>`. */
async function formatHash(password: string, salt: Buffer): Promise<string> {
  const hash = await scryptHash(password, salt);
  return [SCRYPT_PREFIX, salt.toString('base64'), hash.toString('base64')].join(':');
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, which would itself leak
  // length — compare lengths separately and always run the comparison.
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

async function verifyScrypt(password: string, stored: string): Promise<boolean> {
  const [, saltB64, hashB64] = stored.split(':');
  if (!saltB64 || !hashB64) return false;

  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scryptHash(password, Buffer.from(saltB64, 'base64'));
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

function verifyLegacySha256(password: string, stored: string): boolean {
  const digest = crypto.createHash('sha256').update(password).digest('hex');
  return safeEqual(digest, stored);
}

export function isPasswordSet(): boolean {
  return !!(process.env.APP_PASSWORD || getConfig('password_hash'));
}

/**
 * Checks a password at login time.
 *
 * Not used for per-request auth any more — scrypt is intentionally slow,
 * so running it on every request would be both a latency and a DoS
 * problem. Sessions cover that path instead.
 */
export async function verifyPassword(password: string): Promise<boolean> {
  if (!password) return false;

  // .env override takes precedence, as before.
  if (process.env.APP_PASSWORD) {
    return safeEqual(password, process.env.APP_PASSWORD);
  }

  const stored = getConfig('password_hash');
  if (!stored) return false;

  if (stored.startsWith(`${SCRYPT_PREFIX}:`)) {
    return verifyScrypt(password, stored);
  }

  // Legacy unsalted SHA-256 from before this change. Accept once, then
  // immediately upgrade the stored hash so it never matches this branch
  // again.
  if (verifyLegacySha256(password, stored)) {
    await setPassword(password);
    return true;
  }

  return false;
}

export async function setPassword(password: string): Promise<void> {
  setConfig('password_hash', await formatHash(password, crypto.randomBytes(SALT_BYTES)));
}

// ── Login rate limiting ──

/**
 * In-memory failed-login throttle. Single-process and reset on restart,
 * which is adequate here — it exists to make online password guessing
 * impractical, not to survive a reboot.
 */
const MAX_ATTEMPTS = 10;
const LOCKOUT_MS = 15 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

const attempts = new Map<string, { count: number; firstAt: number; lockedUntil: number }>();

export function isRateLimited(key: string): { limited: boolean; retryAfterSec: number } {
  const record = attempts.get(key);
  if (!record) return { limited: false, retryAfterSec: 0 };

  const now = Date.now();
  if (record.lockedUntil > now) {
    return { limited: true, retryAfterSec: Math.ceil((record.lockedUntil - now) / 1000) };
  }

  // Lockout served, or the window lapsed without hitting the limit.
  if (record.lockedUntil !== 0 || now - record.firstAt > ATTEMPT_WINDOW_MS) {
    attempts.delete(key);
  }

  return { limited: false, retryAfterSec: 0 };
}

export function recordFailedLogin(key: string): void {
  const now = Date.now();
  const record = attempts.get(key);

  if (!record || now - record.firstAt > ATTEMPT_WINDOW_MS) {
    attempts.set(key, { count: 1, firstAt: now, lockedUntil: 0 });
    return;
  }

  record.count += 1;
  if (record.count >= MAX_ATTEMPTS) {
    record.lockedUntil = now + LOCKOUT_MS;
  }
}

export function clearLoginAttempts(key: string): void {
  attempts.delete(key);
}

/** Test seam — the throttle is module-level state that outlives an app. */
export function resetLoginAttempts(): void {
  attempts.clear();
}

// ── Middleware ──

/** Pulls a session token from the Authorization header or the cookie. */
export function extractToken(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  return req.cookies?.token;
}

export function isAuthenticated(req: Request): boolean {
  const token = extractToken(req);
  return !!token && verifySession(token);
}

/**
 * Auth gate. Skips:
 *  - POST /api/auth/setup (first-run password creation)
 *  - POST /api/auth/login
 *  - GET /api/auth/status
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const publicPaths = ['/api/auth/setup', '/api/auth/login', '/api/auth/status'];
  if (publicPaths.includes(req.path)) {
    next();
    return;
  }

  // If no password is set, everything is open (first-run state).
  if (!isPasswordSet()) {
    next();
    return;
  }

  if (isAuthenticated(req)) {
    next();
    return;
  }

  res.status(401).json({ error: 'Unauthorized. Please log in.' });
}

/**
 * Bare auth gate with no public-path exemptions, for non-API mounts.
 *
 * Used for /images, which serves receipt photographs and was previously
 * mounted ahead of authMiddleware — i.e. readable by anyone who could
 * reach the port.
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!isPasswordSet() || isAuthenticated(req)) {
    next();
    return;
  }
  res.status(401).json({ error: 'Unauthorized. Please log in.' });
}
