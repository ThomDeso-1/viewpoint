import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { BatchReview } from '../../src/receipts/BatchReview';
import { makeReceipt } from '../helpers/fixtures';

vi.mock('../../src/shared/api');
import * as api from '../../src/shared/api';

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.checkDuplicates.mockResolvedValue({ warnings: [] });
  api.getSettings.mockResolvedValue({ hasClaudeKey: true } as any);
});

function renderBatch() {
  return render(
    <MemoryRouter>
      <BatchReview />
    </MemoryRouter>,
  );
}

/**
 * Spec (CONVERSION-PLAN.md "Batch review queue", revised by migration
 * 010): swipe/step through only the receipts worth a human look —
 * unreadable, or read at medium/low confidence and not yet checked;
 * "All caught up" once the queue is exhausted; Previous is disabled on
 * the first item; saving one advances to the next.
 */
describe('BatchReview', () => {
  it('shows "All caught up" when there is nothing to review', async () => {
    api.listReceipts.mockResolvedValue([]);
    renderBatch();
    await waitFor(() => expect(screen.getByText(/all caught up/i)).toBeInTheDocument());
  });

  it('only queues uncertain or unreadable receipts, in list order', async () => {
    api.listReceipts.mockResolvedValue([
      {
        month: '2026-01',
        receipts: [
          makeReceipt({ id: 'r1', status: 'reviewed', vendor: 'Checked', confidence: 'low' }),
          makeReceipt({ id: 'r2', status: 'extracted', vendor: 'Costco', confidence: 'low' }),
          makeReceipt({ id: 'r3', status: 'extracted', vendor: 'Sure Thing', confidence: 'high' }),
          makeReceipt({ id: 'r4', status: 'needsAttention' }),
          makeReceipt({ id: 'r5', status: 'captured' }),
        ],
      },
    ]);
    api.getReceipt.mockImplementation(async (id: string) =>
      id === 'r2' ? makeReceipt({ id: 'r2', status: 'extracted', vendor: 'Costco', confidence: 'low' }) : makeReceipt({ id: 'r4', status: 'needsAttention' }),
    );
    renderBatch();

    await waitFor(() => expect(screen.getByText(/1 of 2/i)).toBeInTheDocument());
  });

  it('treats a failed load as an empty queue rather than crashing', async () => {
    api.listReceipts.mockRejectedValue(new Error('network down'));
    renderBatch();
    await waitFor(() => expect(screen.getByText(/all caught up/i)).toBeInTheDocument());
  });

  it('Previous is disabled on the first item', async () => {
    api.listReceipts.mockResolvedValue([
      {
        month: '2026-01',
        receipts: [
          makeReceipt({ id: 'r1', status: 'needsAttention' }),
          makeReceipt({ id: 'r2', status: 'needsAttention' }),
        ],
      },
    ]);
    api.getReceipt.mockImplementation(async (id: string) => makeReceipt({ id, status: 'needsAttention' }));
    renderBatch();

    await waitFor(() => expect(screen.getByRole('button', { name: /previous/i })).toBeDisabled());
  });

  it('Skip advances to the next receipt and updates the progress counter', async () => {
    api.listReceipts.mockResolvedValue([
      {
        month: '2026-01',
        receipts: [
          makeReceipt({ id: 'r1', status: 'needsAttention' }),
          makeReceipt({ id: 'r2', status: 'needsAttention' }),
        ],
      },
    ]);
    api.getReceipt.mockImplementation(async (id: string) => makeReceipt({ id, status: 'needsAttention' }));
    renderBatch();

    await waitFor(() => expect(screen.getByText(/1 of 2/i)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /skip/i }));
    await waitFor(() => expect(screen.getByText(/2 of 2/i)).toBeInTheDocument());
  });

  it('shows "All caught up" after skipping past the last item', async () => {
    api.listReceipts.mockResolvedValue([
      { month: '2026-01', receipts: [makeReceipt({ id: 'r1', status: 'needsAttention' })] },
    ]);
    api.getReceipt.mockResolvedValue(makeReceipt({ id: 'r1', status: 'needsAttention' }));
    renderBatch();

    await waitFor(() => expect(screen.getByText(/1 of 1/i)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /skip/i }));
    await waitFor(() => expect(screen.getByText(/all caught up/i)).toBeInTheDocument());
  });

  it('saving the current receipt advances to the next one', async () => {
    api.listReceipts.mockResolvedValue([
      {
        month: '2026-01',
        receipts: [
          makeReceipt({ id: 'r1', status: 'extracted', confidence: 'low', vendor: 'Costco', total_amount: 10, receipt_date: '2026-06-01T00:00:00.000Z' }),
          makeReceipt({ id: 'r2', status: 'extracted', confidence: 'medium', vendor: 'Staples' }),
        ],
      },
    ]);
    api.getReceipt.mockImplementation(async (id: string) =>
      makeReceipt({ id, status: 'extracted', vendor: id === 'r1' ? 'Costco' : 'Staples', total_amount: 10, receipt_date: '2026-06-01T00:00:00.000Z' }),
    );
    api.updateReceipt.mockResolvedValue(makeReceipt({ id: 'r1', status: 'reviewed' }));
    renderBatch();

    await waitFor(() => expect(screen.getByText(/1 of 2/i)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /save as checked/i }));

    await waitFor(() => expect(screen.getByText(/2 of 2/i)).toBeInTheDocument());
  });
});
