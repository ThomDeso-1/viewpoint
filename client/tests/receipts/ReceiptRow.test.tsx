import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReceiptRow } from '../../src/receipts/ReceiptRow';
import { makeReceipt } from '../helpers/fixtures';

describe('ReceiptRow', () => {
  it('shows "Unprocessed" when there is no vendor yet', () => {
    render(<ReceiptRow receipt={makeReceipt({ vendor: null })} onTap={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText('Unprocessed')).toBeInTheDocument();
  });

  it('formats the total as CAD currency', () => {
    render(<ReceiptRow receipt={makeReceipt({ total_amount: 42.5, currency: 'CAD' })} onTap={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText('$42.50')).toBeInTheDocument();
  });

  it('shows no amount when total is null', () => {
    render(<ReceiptRow receipt={makeReceipt({ total_amount: null })} onTap={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.queryByText(/^\$/)).not.toBeInTheDocument();
  });

  it('shows the last error when present', () => {
    render(<ReceiptRow receipt={makeReceipt({ last_error: 'Wave token expired' })} onTap={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText('Wave token expired')).toBeInTheDocument();
  });

  it('calls onTap when the card is clicked', async () => {
    const onTap = vi.fn();
    const { container } = render(<ReceiptRow receipt={makeReceipt()} onTap={onTap} onDelete={vi.fn()} />);
    // Both the card and the delete button have role="button"; target the
    // card itself (not the nested delete button) by its class.
    await userEvent.click(container.querySelector('.receipt-card')!);
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
