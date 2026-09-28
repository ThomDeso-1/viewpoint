import type { ReceiptRow } from '../shared/api';
import type { Tone } from '../ui/Pill';

/**
 * What a receipt's badge says. Receipts are read automatically on upload
 * (no approval step), so the useful signal is how sure Claude was, not
 * the pipeline stage:
 *
 *   captured        → "Reading…"
 *   needsAttention  → "Couldn't read"
 *   extracted       → "High / Medium / Low confidence"
 *   reviewed        → "Checked" (the operator saved it)
 */
export function receiptBadge(r: Pick<ReceiptRow, 'status' | 'confidence'>): { label: string; tone: Tone } {
  switch (r.status) {
    case 'captured':
      return { label: 'Reading…', tone: 'progress' };
    case 'needsAttention':
      return { label: "Couldn't read", tone: 'failed' };
    case 'reviewed':
      return { label: 'Checked', tone: 'done' };
    default:
      if (r.confidence === 'high') return { label: 'High confidence', tone: 'done' };
      if (r.confidence === 'medium') return { label: 'Medium confidence', tone: 'attention' };
      return { label: 'Low confidence', tone: 'failed' };
  }
}

/** Worth a human look: unreadable, or read at less than high confidence and not yet checked. */
export function needsCheck(r: Pick<ReceiptRow, 'status' | 'confidence'>): boolean {
  return r.status === 'needsAttention' || (r.status === 'extracted' && r.confidence !== 'high');
}

/**
 * The receipt's date for display. `receipt_date` is stored as UTC
 * midnight ("2026-08-14T00:00:00.000Z"); handing that to `new Date()`
 * shows the 13th anywhere west of Greenwich. Take the calendar date as
 * written and build a local date from it.
 */
export function receiptLocalDate(receiptDate: string): Date {
  const [y, m, d] = receiptDate.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}
