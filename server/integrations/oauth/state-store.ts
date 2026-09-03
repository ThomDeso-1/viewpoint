import crypto from 'crypto';

/**
 * The pending-`state` map shared by the Google, Wave and Microsoft OAuth
 * flows.
 *
 * `state` is a single-use, short-lived secret minted when the consent
 * flow starts and checked when the provider redirects back. Rejecting a
 * `state` we never issued is what stops an attacker from feeding us an
 * authorization code from their own account, and it stands in for the
 * session cookie the `sameSite: strict` policy withholds on that
 * top-level navigation.
 *
 * One map for all three is safe: tokens are 32 random bytes and matched
 * exactly, so the flows cannot collide. The Microsoft flow additionally
 * stashes its PKCE `code_verifier` here, keyed to the same `state`, so the
 * verifier never leaves the server.
 */

const STATE_TTL_MS = 10 * 60 * 1000;

/** What a pending authorize attempt carries besides its expiry. */
export interface StateData {
  /** PKCE code_verifier, for public-client flows (Microsoft). */
  verifier?: string;
}

interface PendingState extends StateData {
  expiresAt: number;
}

/** Pending authorize attempts, by state token. Single-use and expiring. */
const pendingStates = new Map<string, PendingState>();

function prune(): void {
  const now = Date.now();
  for (const [state, pending] of pendingStates) {
    if (pending.expiresAt <= now) pendingStates.delete(state);
  }
}

export function issueState(data: StateData = {}): string {
  prune();
  const state = crypto.randomBytes(32).toString('base64url');
  pendingStates.set(state, { ...data, expiresAt: Date.now() + STATE_TTL_MS });
  return state;
}

/**
 * Consumes a `state` and returns what it carried, or `null` if it was
 * never issued (or already used / expired). The truthy/falsy result is
 * what the shared callback router checks; the Microsoft callback also
 * reads `.verifier` off it.
 */
export function consumeState(state: string | undefined): StateData | null {
  prune();
  if (!state) return null;
  const pending = pendingStates.get(state);
  if (!pending) return null;
  pendingStates.delete(state); // single use
  const { expiresAt: _expiresAt, ...data } = pending;
  return data;
}

/** Test seam — module-level state outlives an app instance. */
export function resetPendingStates(): void {
  pendingStates.clear();
}
