import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusBadge } from '../../src/components/StatusBadge';

/** Spec (db/schema.sql ReceiptStatus): every pipeline status must have a readable label. */
describe('StatusBadge', () => {
  it.each([
    ['captured', 'Captured'],
    ['extracted', 'Extracted'],
    ['reviewed', 'Reviewed'],
    ['uploaded', 'Uploaded'],
    ['needsAttention', 'Needs Attention'],
    ['failed', 'Failed'],
  ])('labels status "%s" as "%s"', (status, label) => {
    render(<StatusBadge status={status} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('falls back to the raw status string for an unrecognized value', () => {
    render(<StatusBadge status="something-new" />);
    expect(screen.getByText('something-new')).toBeInTheDocument();
  });
});
