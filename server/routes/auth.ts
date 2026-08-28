import { Router, Request, Response } from 'express';
import {
  isPasswordSet,
  verifyPassword,
  setPassword,
  isAuthenticated,
  extractToken,
  isRateLimited,
  recordFailedLogin,
  clearLoginAttempts,
} from '../middleware/auth.js';
import {
  createSession,
  destroySession,
  destroyAllSessions,
  SESSION_COOKIE,
  sessionCookieOptions,
} from '../services/sessions.js';
import { auditRequest } from '../services/audit.js';
import { getConfig } from '../db/db.js';

export function authRoutes(): Router {
  const router = Router();

  // ── GET /api/auth/status — Is the user logged in? Is a password set? ──
  router.get('/status', (req: Request, res: Response): void => {
    if (!isPasswordSet()) {
      res.json({ authenticated: false, needsSetup: true, needsOnboarding: false });
      return;
    }

    const authenticated = isAuthenticated(req);

    res.json({
      authenticated,
      needsSetup: false,
      needsOnboarding: authenticated && getConfig('onboarded') !== 'true',
    });
  });

  // ── POST /api/auth/setup — Set password for the first time ──
  router.post('/setup', async (req: Request, res: Response): Promise<void> => {
    if (isPasswordSet()) {
      res.status(400).json({ error: 'Password is already set. Use login instead.' });
      return;
    }

    const { password } = req.body;
    if (!password || typeof password !== 'string' || password.length < 4) {
      res.status(400).json({ error: 'Password must be at least 4 characters.' });
      return;
    }

    await setPassword(password);
    auditRequest(req, { action: 'password.set' });

    const { token } = createSession(req.headers['user-agent']);
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions(req));

    res.json({ success: true });
  });

  // ── POST /api/auth/login — Verify password, mint a session ──
  router.post('/login', async (req: Request, res: Response): Promise<void> => {
    // Single-user app, so every attempt shares one throttle bucket —
    // rotating source IPs shouldn't buy an attacker extra guesses.
    const throttleKey = 'login';
    const { limited, retryAfterSec } = isRateLimited(throttleKey);

    if (limited) {
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).json({
        error: `Too many failed attempts. Try again in ${Math.ceil(retryAfterSec / 60)} minute(s).`,
      });
      return;
    }

    const { password } = req.body;

    if (!password || !(await verifyPassword(password))) {
      recordFailedLogin(throttleKey);
      auditRequest(req, { action: 'login.failure' });
      res.status(401).json({ error: 'Incorrect password.' });
      return;
    }

    clearLoginAttempts(throttleKey);
    auditRequest(req, { action: 'login.success' });

    const { token } = createSession(req.headers['user-agent']);
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions(req));

    res.json({ success: true });
  });

  // ── POST /api/auth/logout ──
  router.post('/logout', (req: Request, res: Response): void => {
    const token = extractToken(req);
    if (token) destroySession(token);

    auditRequest(req, { action: 'logout' });
    res.clearCookie(SESSION_COOKIE);
    res.json({ success: true });
  });

  // ── POST /api/auth/change-password ──
  router.post('/change-password', async (req: Request, res: Response): Promise<void> => {
    if (!isAuthenticated(req)) {
      res.status(401).json({ error: 'Unauthorized. Please log in.' });
      return;
    }

    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !(await verifyPassword(currentPassword))) {
      auditRequest(req, { action: 'login.failure', detail: 'change-password' });
      res.status(401).json({ error: 'Current password is incorrect.' });
      return;
    }

    if (!newPassword || typeof newPassword !== 'string' || newPassword.length < 4) {
      res.status(400).json({ error: 'New password must be at least 4 characters.' });
      return;
    }

    await setPassword(newPassword);
    auditRequest(req, { action: 'password.set', detail: 'changed' });

    // Every existing session was minted under the old password.
    destroyAllSessions();
    const { token } = createSession(req.headers['user-agent']);
    res.cookie(SESSION_COOKIE, token, sessionCookieOptions(req));

    res.json({ success: true });
  });

  return router;
}
