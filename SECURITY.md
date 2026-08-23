# Security notes

This document tracks known trade-offs in how Viewpoint Receipts handles
authentication and network exposure, and what to revisit if the app's
deployment model changes.

## Current design: local, single-user

The app assumes one trusted user running it on their own machine or a
private server they control, reached over a connection they already trust
(their LAN, or HTTPS via the `deploy/Caddyfile` example with a domain only
they know). On that assumption, the current auth model is an acceptable
trade-off for simplicity:

- **One password, no accounts.** `server/middleware/auth.ts` checks a
  single password against a SHA-256 hash stored in SQLite (or an
  `APP_PASSWORD` env var, which takes precedence). There's no username,
  no per-user permissions, and nothing to manage beyond the one password.
- **The password doubles as the session token.** `POST /api/auth/login`
  and `/setup` set a cookie whose value *is* the password itself
  (`httpOnly`, `sameSite: strict`, 1-year expiry) — see
  `server/routes/auth.ts`. There's no separate, revocable session token:
  logging out just clears the cookie, and the only way to invalidate a
  leaked cookie is to change the password (which also logs out every
  other device).
- **No rate limiting on `/api/auth/login`.** Nothing currently throttles
  or locks out repeated login attempts.
- **CORS is same-origin only.** The client is always served from the same
  origin as the API (proxied in dev via `client/vite.config.ts`, bundled
  together in production), so there's no cross-origin policy to configure
  today.

None of this matters much for a single trusted operator. It would matter
a lot if the app's audience changes.

## Revisit before: multiple users, or untrusted network exposure

If this ever grows beyond "just me, on my own box" — multiple people
using it, or exposing it somewhere an attacker could realistically reach
and probe — do these first:

1. **Rate-limit / lock out `/api/auth/login`.** E.g. exponential backoff
   or a lockout after N failed attempts per IP, so the password isn't
   brute-forceable over the network. Currently unlimited.
2. **Separate session tokens from the password.** Issue an opaque,
   random session token on login (stored server-side or signed), instead
   of using the password as the cookie value. This allows revoking one
   session without rotating the password, and means a leaked cookie
   doesn't hand over the actual credential.
3. **Upgrade password hashing.** Move from unsalted SHA-256 to a proper
   password hash (bcrypt/scrypt/argon2) with per-password salt and a
   deliberately slow work factor, so an offline attacker with DB access
   can't cheaply brute-force it.
4. **Add real multi-user support if needed** — the schema and auth layer
   currently assume exactly one password for the whole app; there's no
   user table or per-user data isolation.

None of this is hard to add later; it's just unnecessary complexity for
the app's current single-user, locally-trusted use case.
