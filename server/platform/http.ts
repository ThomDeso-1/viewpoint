import type { Request, Response, NextFunction } from 'express';

/**
 * Shared HTTP tail: a JSON 404 for unknown API routes and a terminal
 * error handler.
 *
 * Async-handler rejections are made to reach the error handler by
 * `import 'express-async-errors'` in app.ts — Express 4 forwards
 * synchronous throws to error middleware but not promise rejections, so
 * without it an `await` that rejects outside a local try/catch would hang
 * the socket. Express 5 makes the shim unnecessary (see AUDIT P3-24).
 */

/**
 * JSON 404 for anything under /api that no router matched. Mounted before
 * the SPA catch-all, which would otherwise answer an unknown endpoint
 * with index.html and a 200.
 */
export function apiNotFound(req: Request, res: Response): void {
  res.status(404).json({ error: `No such endpoint: ${req.method} ${req.path}` });
}

/**
 * Last middleware in the stack. Logs the failure with its route, and
 * returns a generic message — never the stack or the error text, which
 * can carry a decrypted value or a token.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  console.error(`[error] ${req.method} ${req.originalUrl}:`, err);
  if (res.headersSent) return;
  res.status(500).json({ error: 'Something went wrong on the server.' });
}
