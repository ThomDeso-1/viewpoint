import type { RequestHandler } from 'express';

/**
 * A tiny fixed-window rate limiter, in-memory and per process.
 *
 * Single-user app, so it keys by a route name rather than by IP — the
 * point is to stop a runaway loop or a stuck retry from hammering a paid
 * API (Claude) or the ministry, not to fend off many callers. Resets on
 * restart, like the login throttle in platform/auth.ts.
 */

interface Window {
  count: number;
  startedAt: number;
}

const windows = new Map<string, Window>();

export function checkRateLimit(
  key: string,
  max: number,
  windowMs: number,
  now: number = Date.now(),
): { ok: boolean; retryAfterSec: number } {
  const w = windows.get(key);

  if (!w || now - w.startedAt >= windowMs) {
    windows.set(key, { count: 1, startedAt: now });
    return { ok: true, retryAfterSec: 0 };
  }

  if (w.count < max) {
    w.count += 1;
    return { ok: true, retryAfterSec: 0 };
  }

  return { ok: false, retryAfterSec: Math.ceil((w.startedAt + windowMs - now) / 1000) };
}

/** Express middleware wrapping checkRateLimit — 429 with Retry-After when tripped. */
export function rateLimited(key: string, max: number, windowMs: number): RequestHandler {
  return (_req, res, next) => {
    const { ok, retryAfterSec } = checkRateLimit(key, max, windowMs);
    if (ok) {
      next();
      return;
    }
    res.setHeader('Retry-After', String(retryAfterSec));
    res.status(429).json({
      error: `Too many requests. Try again in ${retryAfterSec} second(s).`,
    });
  };
}

/** Test seam — module-level state outlives an app instance. */
export function resetRateLimits(): void {
  windows.clear();
}
