import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { getConfig, setConfig } from '../db/db.js';

/**
 * Simple single-user auth.
 *
 * On first run the user sets a password via POST /api/auth/setup.
 * Subsequent requests must include it as:
 *   - Bearer token in Authorization header, OR
 *   - `token` cookie (set by POST /api/auth/login)
 *
 * The password hash is stored in the SQLite app_config table.
 */

function hashPassword(password: string): string {
  return crypto.createHash('sha256').update(password).digest('hex');
}

export function isPasswordSet(): boolean {
  return !!(process.env.APP_PASSWORD || getConfig('password_hash'));
}

export function verifyPassword(password: string): boolean {
  // Check .env first (takes precedence)
  if (process.env.APP_PASSWORD) {
    return password === process.env.APP_PASSWORD;
  }
  // Check stored hash
  const storedHash = getConfig('password_hash');
  if (!storedHash) return false;
  return hashPassword(password) === storedHash;
}

export function setPassword(password: string): void {
  setConfig('password_hash', hashPassword(password));
}

/**
 * Auth middleware. Skips auth for:
 *  - POST /api/auth/setup (first-run password creation)
 *  - POST /api/auth/login
 *  - GET /api/auth/status
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Public routes
  const publicPaths = ['/api/auth/setup', '/api/auth/login', '/api/auth/status'];
  if (publicPaths.includes(req.path)) {
    next();
    return;
  }

  // If no password is set, everything is open (first-run state)
  if (!isPasswordSet()) {
    next();
    return;
  }

  // Check Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    if (verifyPassword(token)) {
      next();
      return;
    }
  }

  // Check cookie
  const cookieToken = req.cookies?.token;
  if (cookieToken && verifyPassword(cookieToken)) {
    next();
    return;
  }

  res.status(401).json({ error: 'Unauthorized. Please log in.' });
}
