import crypto from 'crypto';

/**
 * PKCE (RFC 7636) for the authorization-code flow.
 *
 * Used by the Microsoft flow, which runs as a **public client** — the app
 * ships without a client secret because a desktop install cannot keep one
 * secret. PKCE is what stands in for the secret: the `code_verifier` is
 * generated when the consent flow starts, held server-side against the
 * single-use `state`, and sent only on the token exchange, so an
 * authorization code intercepted in the redirect is useless without it.
 */

/** A fresh verifier / S256 challenge pair. */
export function createPkcePair(): { verifier: string; challenge: string } {
  // 32 bytes base64url ≈ 43 chars — within the 43–128 the spec allows.
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}
