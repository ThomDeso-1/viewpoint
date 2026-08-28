import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Inbox } from '../../src/practice/Inbox';
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
    gmailQueryConfigured: true,
  });
});

function renderInbox() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <Inbox />
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
    renderInbox();
    const banner = await screen.findByText(/mock/i);
    expect(banner).toBeInTheDocument();
    expect(screen.getByText(/results are simulated/i)).toBeInTheDocument();
  });

  it('prompts to configure a Gmail search when none is set', async () => {
    api.getExamRequestCounts.mockResolvedValue({
      counts: {},
      hcvMode: 'mock',
      gmailQueryConfigured: false,
    });
    renderInbox();
    expect(await screen.findByText(/No Gmail search is configured/i)).toBeInTheDocument();
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

  it('checks email on demand', async () => {
    api.pollExamRequests.mockResolvedValue({ success: true, created: 2 });
    renderInbox();

    await userEvent.click(await screen.findByRole('button', { name: /Check email/i }));
    await waitFor(() => expect(api.pollExamRequests).toHaveBeenCalled());
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
