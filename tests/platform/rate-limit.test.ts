import { describe, it, expect, beforeEach } from 'vitest';
import { checkRateLimit, resetRateLimits } from '../../server/platform/rate-limit.js';

/**
 * P1-5: the fixed-window limiter guarding the paid-API / ministry routes
 * (poll, validate-claude-key, ohip/test, check-eligibility).
 */

describe('rate limiter', () => {
  beforeEach(resetRateLimits);

  it('allows up to max within a window, then 429s with a retry hint', () => {
    for (let i = 0; i < 3; i++) {
      expect(checkRateLimit('k', 3, 60_000, 1_000 + i).ok).toBe(true);
    }
    const blocked = checkRateLimit('k', 3, 60_000, 1_010);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it('resets once the window elapses', () => {
    expect(checkRateLimit('k', 1, 1000, 0).ok).toBe(true);
    expect(checkRateLimit('k', 1, 1000, 500).ok).toBe(false);
    expect(checkRateLimit('k', 1, 1000, 1500).ok).toBe(true);
  });

  it('keys are independent', () => {
    expect(checkRateLimit('a', 1, 1000, 0).ok).toBe(true);
    expect(checkRateLimit('b', 1, 1000, 0).ok).toBe(true);
  });
});
