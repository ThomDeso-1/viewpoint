import { describe, it, expect } from 'vitest';
import { applyFailure } from '../../server/platform/failure.js';

/**
 * The shared failure transition (audit P3-28). Each case mirrors one of
 * the three call sites' policies so a divergence would show up here.
 */
describe('applyFailure', () => {
  describe('receipt upload queue policy (retrying: reviewed, countAlways)', () => {
    const policy = { retrying: 'reviewed', exhausted: 'failed', maxRetries: 5, countAlways: true } as const;

    it('retryable with budget left → stays reviewed, count bumped', () => {
      expect(applyFailure({ retry_count: 0 }, true, policy)).toEqual({ status: 'reviewed', retryCount: 1 });
    });

    it('retryable at the ceiling → failed', () => {
      expect(applyFailure({ retry_count: 4 }, true, policy)).toEqual({ status: 'failed', retryCount: 5 });
    });

    it('non-retryable → failed immediately, and still counts', () => {
      expect(applyFailure({ retry_count: 0 }, false, policy)).toEqual({ status: 'failed', retryCount: 1 });
    });
  });

  describe('exam-request policy (retrying: current status, terminal: needsAttention)', () => {
    const policy = { retrying: 'extracted', exhausted: 'failed', terminal: 'needsAttention', maxRetries: 5 } as const;

    it('retryable with budget left → keeps its current status', () => {
      expect(applyFailure({ retry_count: 1 }, true, policy)).toEqual({ status: 'extracted', retryCount: 2 });
    });

    it('non-retryable → needsAttention, and does NOT count', () => {
      expect(applyFailure({ retry_count: 2 }, false, policy)).toEqual({ status: 'needsAttention', retryCount: 2 });
    });

    it('retryable at the ceiling → failed', () => {
      expect(applyFailure({ retry_count: 4 }, true, policy)).toEqual({ status: 'failed', retryCount: 5 });
    });
  });

  describe('reminder policy (retrying: pending, terminal defaults to exhausted)', () => {
    const policy = { retrying: 'pending', exhausted: 'failed', maxRetries: 5 } as const;

    it('non-retryable → failed (terminal falls back to exhausted)', () => {
      expect(applyFailure({ retry_count: 0 }, false, policy)).toEqual({ status: 'failed', retryCount: 0 });
    });

    it('retryable, budget left → pending', () => {
      expect(applyFailure({ retry_count: 0 }, true, policy)).toEqual({ status: 'pending', retryCount: 1 });
    });
  });

  it('defaults maxRetries to 5 when unspecified', () => {
    const policy = { retrying: 'pending', exhausted: 'failed' } as const;
    expect(applyFailure({ retry_count: 4 }, true, policy).status).toBe('failed');
    expect(applyFailure({ retry_count: 3 }, true, policy).status).toBe('pending');
  });
});
