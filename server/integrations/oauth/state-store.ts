import crypto from 'crypto';

/**
 * The pending-`state` map shared by the Google and Wave OAuth flows.
 *
 * `state` is a single-use, short-lived secret minted when the consent
 * flow starts and checked when the provider redirects back. Rejecting a
 * `state` we never issued is what stops an attacker from feeding us an
 * authorization code from their own account, and it stands in for the
 * session cookie the `sameSite: strict` policy withholds on that
 * top-level navigation.
 *
 * One map for both providers is safe: tokens are 32 random bytes and
 * matched exactly, so the flows cannot collide.
 */

const STATE_TTL_MS = 10 * 60 * 1000;

/** Pending authorize attempts, by state token. Single-use and expiring. */
const pendingStates = new Map<string, number>();

function prune(): void {
  const now = Date.now();
  for (const [state, expiry] of pendingStates) {
    if (expiry <= now) pendingStates.delete(state);
  }
}

export function issueState(): string {
  prune();
  const state = crypto.randomBytes(32).toString('base64url');
  pendingStates.set(state, Date.now() + STATE_TTL_MS);
  return state;
}

export function consumeState(state: string | undefined): boolean {
  prune();
  if (!state || !pendingStates.has(state)) return false;
  pendingStates.delete(state); // single use
  return true;
}

/** Test seam — module-level state outlives an app instance. */
export function resetPendingStates(): void {
  pendingStates.clear();
}
