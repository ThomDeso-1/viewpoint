import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReceiptRow } from '../../src/receipts/ReceiptRow';
import { makeReceipt } from '../helpers/fixtures';

describe('ReceiptRow', () => {
  it('shows "Reading receipt…" and the upload date while Claude is still reading it', () => {
    render(<ReceiptRow receipt={makeReceipt({ status: 'captured', vendor: null })} onTap={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText('Reading receipt…')).toBeInTheDocument();
    expect(screen.getByText('Reading…')).toBeInTheDocument();
    expect(screen.getByText(/^Uploaded /)).toBeInTheDocument();
  });

  it.each([
    ['high', 'High confidence'],
    ['medium', 'Medium confidence'],
    ['low', 'Low confidence'],
  ])('badges an extracted receipt with its %s confidence', (confidence, label) => {
    render(<ReceiptRow receipt={makeReceipt({ status: 'extracted', vendor: 'Staples', confidence })} onTap={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('badges a checked receipt as "Checked" and an unreadable one as "Couldn\'t read"', () => {
    const { unmount } = render(<ReceiptRow receipt={makeReceipt({ status: 'reviewed', vendor: 'X' })} onTap={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText('Checked')).toBeInTheDocument();
    unmount();
    render(<ReceiptRow receipt={makeReceipt({ status: 'needsAttention' })} onTap={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText("Couldn't read")).toBeInTheDocument();
  });

  it('shows the date printed on the receipt, not the day before (UTC-midnight storage)', () => {
    render(
      <ReceiptRow
        receipt={makeReceipt({ status: 'extracted', vendor: 'X', receipt_date: '2026-08-01T00:00:00.000Z' })}
        onTap={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText(/Aug\.? 1$/)).toBeInTheDocument();
  });

  it('formats the total as CAD currency', () => {
    render(<ReceiptRow receipt={makeReceipt({ total_amount: 42.5, currency: 'CAD' })} onTap={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText('$42.50')).toBeInTheDocument();
  });

  it('shows no amount when total is null', () => {
    render(<ReceiptRow receipt={makeReceipt({ total_amount: null })} onTap={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.queryByText(/^\$/)).not.toBeInTheDocument();
  });

  it("shows why Claude couldn't read it", () => {
    render(
      <ReceiptRow receipt={makeReceipt({ status: 'needsAttention', last_error: 'Image too blurry' })} onTap={vi.fn()} onDelete={vi.fn()} />,
    );
    expect(screen.getByText('Image too blurry')).toBeInTheDocument();
  });

  it('calls onTap when the card is clicked', async () => {
    const onTap = vi.fn();
    const { container } = render(<ReceiptRow receipt={makeReceipt()} onTap={onTap} onDelete={vi.fn()} />);
    // The row is two sibling buttons; target the main one, not delete.
    await userEvent.click(container.querySelector('.vp-receipt-row-main')!);
    expect(onTap).toHaveBeenCalled();
  });

  it('calls onDelete (not onTap) when the delete button is clicked', async () => {
    const onTap = vi.fn();
    const onDelete = vi.fn();
    render(<ReceiptRow receipt={makeReceipt()} onTap={onTap} onDelete={onDelete} />);
    await userEvent.click(screen.getByTitle(/delete receipt/i));
    expect(onDelete).toHaveBeenCalled();
    expect(onTap).not.toHaveBeenCalled();
  });
});
