import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ReceiptList } from '../../src/receipts/ReceiptList';
import { ToastProvider } from '../../src/shared/Toast';
import { makeReceipt } from '../helpers/fixtures';

vi.mock('../../src/shared/api');
import * as api from '../../src/shared/api';

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.listReceipts.mockResolvedValue([]);
  api.getQueueStatus.mockResolvedValue({ uploaded: 0, pending: 0, failed: 0, captured: 0 });
  api.getHealthStatus.mockResolvedValue({ claudeConfigured: false, claudeHealthy: null, waveConfigured: false, waveHealthy: null });
  // ReceiptList reads this for the demo-mode banner. Fully-connected so the
  // setup checklist stays hidden and doesn't clutter these assertions.
  api.getSettings.mockResolvedValue({
    demoMode: false,
    hasClaudeKey: true,
    hasWaveToken: true,
    microsoftConnected: true,
  } as any);
  api.getExamSettings.mockResolvedValue({ sourceFolder: '/files', invoicingReady: true } as any);
  vi.stubGlobal('confirm', vi.fn(() => true));
});

function renderList() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <ReceiptList />
      </ToastProvider>
    </MemoryRouter>,
  );
}

/**
 * Spec (GETTING-STARTED.md "Using it day to day" + CONVERSION-PLAN.md
 * "Health check banner", "Batch review queue"):
 *  - Empty state when there are no receipts.
 *  - Health banners for an invalid Claude key / expired Wave token.
 *  - "Review All (N)" only appears once there's more than one reviewable
 *    (captured/extracted) receipt.
 *  - Deleting asks for confirmation first.
 */
describe('ReceiptList', () => {
  it('shows an empty state with no receipts', async () => {
    renderList();
    await waitFor(() => expect(screen.getByText(/no receipts yet/i)).toBeInTheDocument());
  });

  it('renders receipts grouped by month with vendor and status', async () => {
    api.listReceipts.mockResolvedValue([
      { month: '2026-01', receipts: [makeReceipt({ id: 'r1', vendor: 'Costco', status: 'reviewed' })] },
    ]);
    renderList();
    await waitFor(() => expect(screen.getByText('Costco')).toBeInTheDocument());
  });

  it('shows a Claude health banner only when a key is configured and unhealthy', async () => {
    api.getHealthStatus.mockResolvedValue({ claudeConfigured: true, claudeHealthy: false, waveConfigured: false, waveHealthy: null });
    renderList();
    await waitFor(() => expect(screen.getByText(/claude api key is invalid/i)).toBeInTheDocument());
  });

  it('does not show a Claude health banner when no key is configured at all', async () => {
    api.getHealthStatus.mockResolvedValue({ claudeConfigured: false, claudeHealthy: null, waveConfigured: false, waveHealthy: null });
    renderList();
    await waitFor(() => expect(screen.getByText(/no receipts yet/i)).toBeInTheDocument());
    expect(screen.queryByText(/claude api key is invalid/i)).not.toBeInTheDocument();
  });

  it('shows a Wave health banner when the connection has expired', async () => {
    api.getHealthStatus.mockResolvedValue({ claudeConfigured: false, claudeHealthy: null, waveConfigured: true, waveHealthy: false });
    renderList();
    await waitFor(() => expect(screen.getByText(/wave connection has expired/i)).toBeInTheDocument());
  });

  it('hides "Review All" when there is only 1 reviewable receipt', async () => {
    api.listReceipts.mockResolvedValue([
      { month: '2026-01', receipts: [makeReceipt({ id: 'r1', status: 'captured' })] },
    ]);
    renderList();
    await waitFor(() => expect(screen.getByText('Unprocessed')).toBeInTheDocument());
    expect(screen.queryByText(/review all/i)).not.toBeInTheDocument();
  });

  it('shows "Review All (N)" once more than one receipt needs review', async () => {
    api.listReceipts.mockResolvedValue([
      {
        month: '2026-01',
        receipts: [
          makeReceipt({ id: 'r1', status: 'captured' }),
          makeReceipt({ id: 'r2', status: 'extracted' }),
        ],
      },
    ]);
    renderList();
    await waitFor(() => expect(screen.getByText(/review all \(2\)/i)).toBeInTheDocument());
  });

  it('does not count uploaded/reviewed receipts toward the reviewable total', async () => {
    api.listReceipts.mockResolvedValue([
      {
        month: '2026-01',
        receipts: [
          makeReceipt({ id: 'r1', status: 'captured' }),
          makeReceipt({ id: 'r2', status: 'uploaded' }),
          makeReceipt({ id: 'r3', status: 'reviewed' }),
        ],
      },
    ]);
    renderList();
    await waitFor(() => expect(screen.getAllByText('Unprocessed')).toHaveLength(3));
    expect(screen.queryByText(/review all/i)).not.toBeInTheDocument();
  });

  it('filters the list via the search box', async () => {
    api.listReceipts.mockResolvedValue([]);
    renderList();
    await waitFor(() => expect(api.listReceipts).toHaveBeenCalledWith(undefined));

    await userEvent.type(screen.getByPlaceholderText(/search receipts/i), 'costco');
    await waitFor(() => expect(api.listReceipts).toHaveBeenCalledWith({ search: 'costco' }));
  });

  it('asks for confirmation before deleting, and does nothing if declined', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    api.listReceipts.mockResolvedValue([
      { month: '2026-01', receipts: [makeReceipt({ id: 'r1', vendor: 'Costco' })] },
    ]);
    renderList();
    await waitFor(() => expect(screen.getByText('Costco')).toBeInTheDocument());

    await userEvent.click(screen.getByTitle(/delete receipt/i));
    expect(api.deleteReceipt).not.toHaveBeenCalled();
  });

  it('deletes the receipt and refreshes the list once confirmed', async () => {
    api.listReceipts
      .mockResolvedValueOnce([{ month: '2026-01', receipts: [makeReceipt({ id: 'r1', vendor: 'Costco' })] }])
      .mockResolvedValueOnce([]);
    api.deleteReceipt.mockResolvedValue({ deleted: true });
    renderList();
    await waitFor(() => expect(screen.getByText('Costco')).toBeInTheDocument());

    await userEvent.click(screen.getByTitle(/delete receipt/i));
    expect(api.deleteReceipt).toHaveBeenCalledWith('r1');
    await waitFor(() => expect(screen.getByText(/no receipts yet/i)).toBeInTheDocument());
  });

  it('shows a toast if deletion fails', async () => {
    api.listReceipts.mockResolvedValue([
      { month: '2026-01', receipts: [makeReceipt({ id: 'r1', vendor: 'Costco' })] },
    ]);
    api.deleteReceipt.mockRejectedValue(new Error('Receipt not found.'));
    renderList();
    await waitFor(() => expect(screen.getByText('Costco')).toBeInTheDocument());

    await userEvent.click(screen.getByTitle(/delete receipt/i));
    expect(await screen.findByText('Receipt not found.')).toBeInTheDocument();
  });
});

/**
 * Demo mode has to be unmissable: a fabricated invoice or eligibility
 * result must never be mistaken for a real one.
 */
describe('ReceiptList: demo mode', () => {
  it('warns loudly when the app is running against local fakes', async () => {
    api.getSettings.mockResolvedValue({ demoMode: true } as any);
    renderList();

    expect(await screen.findByText(/Demo mode/i)).toBeInTheDocument();
    expect(screen.getByText(/local fakes/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /captured/i })).toBeInTheDocument();
  });

  it('shows nothing when running normally', async () => {
    api.getSettings.mockResolvedValue({ demoMode: false } as any);
    renderList();

    await screen.findByText(/No receipts yet|no receipts/i);
    expect(screen.queryByText(/Demo mode/i)).not.toBeInTheDocument();
  });
});
