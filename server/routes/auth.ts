import { Router, Request, Response } from 'express';
import { isPasswordSet, verifyPassword, setPassword } from '../middleware/auth.js';
import { getConfig } from '../db/db.js';

export function authRoutes(): Router {
  const router = Router();

  // ── GET /api/auth/status — Is the user logged in? Is a password set? ──
  router.get('/status', (req: Request, res: Response): void => {
    const passwordSet = isPasswordSet();

    if (!passwordSet) {
      res.json({ authenticated: false, needsSetup: true, needsOnboarding: false });
      return;
    }

    // Check if current request is authenticated
    const authHeader = req.headers.authorization;
    const bearerOk = authHeader?.startsWith('Bearer ') && verifyPassword(authHeader.slice(7));
    const cookieOk = req.cookies?.token && verifyPassword(req.cookies.token);
    const authenticated = !!(bearerOk || cookieOk);

    res.json({
      authenticated,
      needsSetup: false,
      needsOnboarding: authenticated && getConfig('onboarded') !== 'true',
    });
  });

  // ── POST /api/auth/setup — Set password for the first time ──
  router.post('/setup', (req: Request, res: Response): void => {
    if (isPasswordSet()) {
      res.status(400).json({ error: 'Password is already set. Use login instead.' });
      return;
    }

    const { password } = req.body;
    if (!password || typeof password !== 'string' || password.length < 4) {
      res.status(400).json({ error: 'Password must be at least 4 characters.' });
      return;
    }

    setPassword(password);

    // Set cookie
    res.cookie('token', password, {
      httpOnly: true,
      sameSite: 'strict',
      maxAge: 365 * 24 * 60 * 60 * 1000, // 1 year
    });

    res.json({ success: true });
  });

  // ── POST /api/auth/login — Verify password and set cookie ──
  router.post('/login', (req: Request, res: Response): void => {
    const { password } = req.body;

    if (!password || !verifyPassword(password)) {
      res.status(401).json({ error: 'Incorrect password.' });
      return;
    }

    res.cookie('token', password, {
      httpOnly: true,
      sameSite: 'strict',
      maxAge: 365 * 24 * 60 * 60 * 1000,
    });

    res.json({ success: true });
  });

  // ── POST /api/auth/logout ──
  router.post('/logout', (_req: Request, res: Response): void => {
    res.clearCookie('token');
    res.json({ success: true });
  });

  return router;
}
