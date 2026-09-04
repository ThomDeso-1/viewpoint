/**
 * Base for the provider API error classes (Microsoft, Wave, OHIP HCV,
 * Claude) — each extends this for a `name` distinct enough to tell them
 * apart in logs and `instanceof` checks, while sharing the one taxonomy
 * this codebase's retry loops actually read: `network_error` and
 * `server_error` are worth retrying, everything else (bad input, auth
 * rejected, not found, ...) is not. A subclass with its own retry rule
 * (Claude's `rate_limited`) overrides `isRetryable`.
 */
export class ApiError extends Error {
  code: string;

  constructor(name: string, code: string, message: string) {
    super(message);
    this.name = name;
    this.code = code;
  }

  get isRetryable(): boolean {
    return this.code === 'network_error' || this.code === 'server_error';
  }
}
