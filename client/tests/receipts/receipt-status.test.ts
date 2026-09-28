import { describe, it, expect } from 'vitest';
import { needsCheck, receiptBadge, receiptLocalDate } from '../../src/receipts/receipt-status';

describe('receipt status helpers', () => {
  it('needs a check only when unreadable, or read at less than high confidence and unchecked', () => {
    expect(needsCheck({ status: 'needsAttention', confidence: null })).toBe(true);
    expect(needsCheck({ status: 'extracted', confidence: 'low' })).toBe(true);
    expect(needsCheck({ status: 'extracted', confidence: 'medium' })).toBe(true);
    expect(needsCheck({ status: 'extracted', confidence: 'high' })).toBe(false);
    expect(needsCheck({ status: 'reviewed', confidence: 'low' })).toBe(false);
    expect(needsCheck({ status: 'captured', confidence: null })).toBe(false);
  });

  it('badges an extracted receipt with no stored confidence as low', () => {
    expect(receiptBadge({ status: 'extracted', confidence: null }).label).toBe('Low confidence');
  });

  it('reads the stored UTC-midnight date as the calendar date on the receipt', () => {
    const d = receiptLocalDate('2026-08-01T00:00:00.000Z');
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 7, 1]);
  });
});
