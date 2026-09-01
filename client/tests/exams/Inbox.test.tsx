import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Inbox } from '../../src/exams/Inbox';
import { ToastProvider } from '../../src/shared/Toast';
import { makeExamRequest } from '../helpers/fixtures';

vi.mock('../../src/shared/api');
import * as api from '../../src/shared/api';

beforeEach(() => {
  for (const fn of Object.values(api)) (fn as any).mockReset?.();
  api.getExamRequests.mockResolvedValue([]);
  api.getExamRequestCounts.mockResolvedValue({
    counts: {},
    hcvMode: 'mock',
    sourceFolderConfigured: true,
    filesWithErrors: 0,
  });
});

function renderInbox({ ohipEnabled = false }: { ohipEnabled?: boolean } = {}) {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <Inbox ohipEnabled={ohipEnabled} />
      </ToastProvider>
    </MemoryRouter>,
  );
}

/**
 * Spec: the inbox drafts everything but commits nothing. Approve is the
 * only action that reaches a patient or the books, and a simulated OHIP
 * result must always be labelled as such.
 */
describe('Inbox', () => {
  it('shows an empty state when nothing is waiting', async () => {
    renderInbox();
    expect(await screen.findByText(/Nothing waiting/i)).toBeInTheDocument();
  });

  it('warns loudly when OHIP results are simulated', async () => {
    renderInbox({ ohipEnabled: true });
    const banner = await screen.findByText(/mock/i);
    expect(banner).toBeInTheDocument();
    expect(screen.getByText(/results are simulated/i)).toBeInTheDocument();
  });

  it('shows the schedule coverage status, not a mock banner, when OHIP is off', async () => {
    api.getExamRequests.mockResolvedValue([makeExamRequest()]);
    renderInbox();

    await screen.findByText('Ada Lovelace');
    expect(screen.queryByText(/results are simulated/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Coverage \(schedule\)/i)).toBeInTheDocument();
    expect(screen.getByText(/from the schedule/i)).toBeInTheDocument();
  });

  it('prompts to set a patient files folder when none is configured', async () => {
    api.getExamRequestCounts.mockResolvedValue({
      counts: {},
      hcvMode: 'mock',
      sourceFolderConfigured: false,
      filesWithErrors: 0,
    });
    renderInbox();
    expect(await screen.findByText(/No patient files folder is set/i)).toBeInTheDocument();
  });

  it('renders the drafted package for a request', async () => {
    api.getExamRequests.mockResolvedValue([makeExamRequest()]);
    renderInbox();

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText(/Covered/)).toBeInTheDocument();
    expect(screen.getByText(/Ready to approve/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
  });

  it('never displays a full health card number', async () => {
    api.getExamRequests.mockResolvedValue([makeExamRequest()]);
    const { container } = renderInbox();

    await screen.findByText('Ada Lovelace');
    expect(container.textContent).toContain('••7890');
    expect(container.textContent).not.toMatch(/\b\d{10}\b/);
  });

  it('fetches the source record only on demand (P0-1)', async () => {
    api.getExamRequests.mockResolvedValue([makeExamRequest({ has_source: true })]);
    api.getExamRequestSource.mockResolvedValue({ body: 'Please book Ada an exam.' });
    renderInbox();

    await screen.findByText('Ada Lovelace');
    expect(api.getExamRequestSource).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /show source record/i }));

    await waitFor(() => expect(api.getExamRequestSource).toHaveBeenCalledWith('req-1'));
    expect(await screen.findByText(/Please book Ada an exam/)).toBeInTheDocument();
  });

  it('hides the source-record toggle when nothing was retained', async () => {
    api.getExamRequests.mockResolvedValue([makeExamRequest({ has_source: false })]);
    renderInbox();

    await screen.findByText('Ada Lovelace');
    expect(screen.queryByRole('button', { name: /source record/i })).not.toBeInTheDocument();
  });

  it('offers Approve only once a request is drafted', async () => {
    api.getExamRequests.mockResolvedValue([makeExamRequest({ status: 'received' })]);
    renderInbox();

    await screen.findByText('Ada Lovelace');
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('approves a request and reports success', async () => {
    const request = makeExamRequest();
    api.getExamRequests.mockResolvedValue([request]);
    api.approveExamRequest.mockResolvedValue({
      success: true,
      invoice: { created: true, error: null },
      reminder: { scheduled: true, error: null },
      request,
    });

    renderInbox();
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(api.approveExamRequest).toHaveBeenCalledWith('req-1'));
    expect(await screen.findByText(/invoice sent and reminder scheduled/i)).toBeInTheDocument();
  });

  it('surfaces an invoice failure rather than reporting plain success', async () => {
    api.getExamRequests.mockResolvedValue([makeExamRequest()]);
    api.approveExamRequest.mockResolvedValue({
      success: true,
      invoice: { created: false, error: 'Wave is not configured.' },
      reminder: { scheduled: false, error: null },
      request: makeExamRequest(),
    });

    renderInbox();
    await userEvent.click(await screen.findByRole('button', { name: 'Approve' }));

    expect(await screen.findByText(/the invoice failed: Wave is not configured/i)).toBeInTheDocument();
  });

  it('dismisses a request without sending anything', async () => {
    api.getExamRequests.mockResolvedValue([makeExamRequest()]);
    api.rejectExamRequest.mockResolvedValue({ success: true });

    renderInbox();
    await userEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));

    await waitFor(() => expect(api.rejectExamRequest).toHaveBeenCalledWith('req-1'));
    expect(api.approveExamRequest).not.toHaveBeenCalled();
    expect(await screen.findByText(/Nothing was sent/i)).toBeInTheDocument();
  });

  it('offers a retry for a request that needs attention', async () => {
    api.getExamRequests.mockResolvedValue([
      makeExamRequest({ status: 'needsAttention', last_error: 'Low confidence (0.20)' }),
    ]);
    api.retryExamRequest.mockResolvedValue({ success: true });

    renderInbox();
    expect(await screen.findByText(/Low confidence/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Try again/i }));
    await waitFor(() => expect(api.retryExamRequest).toHaveBeenCalledWith('req-1'));
  });

  it('previews the reminder before it is sent', async () => {
    api.getExamRequests.mockResolvedValue([makeExamRequest()]);
    renderInbox();

    await userEvent.click(await screen.findByRole('button', { name: 'Preview' }));
    expect(screen.getByText(/This is a reminder/)).toBeInTheDocument();
  });

  it('shows merged notes on the card', async () => {
    api.getExamRequests.mockResolvedValue([
      makeExamRequest({
        extraction: { ...makeExamRequest().extraction!, notes: 'Private pay $180 — confirm before clinic.' },
      }),
    ]);
    renderInbox();

    expect(await screen.findByText(/Private pay \$180/)).toBeInTheDocument();
  });

  it('overrides the reminder lead time from the card', async () => {
    api.getExamRequests.mockResolvedValue([makeExamRequest()]);
    api.updateExamReminder.mockResolvedValue({ success: true, request: makeExamRequest() });
    renderInbox();

    await screen.findByText('Ada Lovelace');
    await userEvent.selectOptions(screen.getByLabelText(/Remind/i), '72');

    await waitFor(() => expect(api.updateExamReminder).toHaveBeenCalledWith('req-1', 72));
  });

  it('scans the folder on demand', async () => {
    api.scanExamRequests.mockResolvedValue({ success: true, created: 2 });
    renderInbox();

    await userEvent.click(await screen.findByRole('button', { name: /Scan folder/i }));
    await waitFor(() => expect(api.scanExamRequests).toHaveBeenCalled());
    expect(await screen.findByText(/Found 2 new requests/i)).toBeInTheDocument();
  });

  describe('invoice editing', () => {
    it('offers to edit while the invoice is still a draft', async () => {
      api.getExamRequests.mockResolvedValue([makeExamRequest()]);
      renderInbox();

      expect(await screen.findByRole('button', { name: /Edit lines/i })).toBeInTheDocument();
    });

    it('does not offer editing once the invoice exists in Wave', async () => {
      const request = makeExamRequest();
      api.getExamRequests.mockResolvedValue([
        {
          ...request,
          invoice: { ...request.invoice!, status: 'sent', editable: false, wave_invoice_id: 'inv-1' },
        },
      ]);
      renderInbox();

      await screen.findByText('Ada Lovelace');
      expect(screen.queryByRole('button', { name: /Edit lines/i })).not.toBeInTheDocument();
    });

    it('opens the editor with the drafted lines', async () => {
      api.getExamRequests.mockResolvedValue([makeExamRequest()]);
      renderInbox();

      await userEvent.click(await screen.findByRole('button', { name: /Edit lines/i }));

      expect(screen.getByDisplayValue('Comprehensive eye examination')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Save invoice' })).toBeInTheDocument();
    });

    it('reloads the request after the invoice is saved', async () => {
      api.getExamRequests.mockResolvedValue([makeExamRequest()]);
      api.updateInvoiceLineItems.mockResolvedValue({ success: true, request: makeExamRequest() });
      renderInbox();

      await userEvent.click(await screen.findByRole('button', { name: /Edit lines/i }));
      await userEvent.click(screen.getByRole('button', { name: 'Save invoice' }));

      await waitFor(() => expect(api.updateInvoiceLineItems).toHaveBeenCalled());
      // Initial load plus the reload triggered by saving.
      expect(api.getExamRequests.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('reports when an appointment could not be matched', async () => {
    api.getExamRequests.mockResolvedValue([makeExamRequest({ appointment: null })]);
    renderInbox();

    expect(await screen.findByText(/no calendar match/i)).toBeInTheDocument();
  });
});
