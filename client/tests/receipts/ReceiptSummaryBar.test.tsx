import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReceiptSummaryBar } from '../../src/receipts/ReceiptSummaryBar';

describe('ReceiptSummaryBar', () => {
  it('renders nothing when every count is zero', () => {
    const { container } = render(<ReceiptSummaryBar summary={{ processing: 0, toCheck: 0, unreadable: 0 }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('only shows pills for non-zero categories', () => {
    render(<ReceiptSummaryBar summary={{ processing: 0, toCheck: 3, unreadable: 0 }} />);
    expect(screen.getByText('3 To check')).toBeInTheDocument();
    expect(screen.queryByText(/reading/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/couldn't read/i)).not.toBeInTheDocument();
  });

  it('shows all three pills when every count is non-zero', () => {
    render(<ReceiptSummaryBar summary={{ processing: 2, toCheck: 1, unreadable: 4 }} />);
    expect(screen.getByText('2 Reading')).toBeInTheDocument();
    expect(screen.getByText('1 To check')).toBeInTheDocument();
    expect(screen.getByText("4 Couldn't read")).toBeInTheDocument();
  });
});
