import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ExamSettings } from '../../src/exams/ExamSettings';
import { ToastProvider } from '../../src/shared/Toast';
import type { ExamSettings as Data } from '../../src/shared/api';

vi.mock('../../src/shared/api');
import * as api from '../../src/shared/api';

function settings(overrides: Partial<Data> = {}): Data {
  return {
    gmailQuery: 'label:exam-requests',
    minConfidence: 0.6,
    businessName: 'Viewpoint Vision Care',
    businessTimezone: 'America/Toronto',
    reminderLeadHours: 24,
    examFeeAmount: 120,
    waveIncomeAccountId: '',
    waveServiceProductId: '',
    invoicingReady: false,
    ...overrides,
  };
}

beforeEach(() => {
  for (const fn of Object.values(api)) (fn as any).mockReset?.();
  api.getExamSettings.mockResolvedValue(settings());
  api.saveExamSettings.mockResolvedValue({ success: true });
  api.getWaveInvoiceTargets.mockResolvedValue({
    income: [{ id: 'income-1', name: 'Professional Fees' }],
    products: [{ id: 'prod-1', name: 'Eye Exam', unitPrice: 120 }],
  });
});

function renderPanel() {
  return render(
    <ToastProvider>
      <ExamSettings />
    </ToastProvider>,
  );
}

/**
 * Spec: invoices need either a service product or an income account —
 * never both — and the panel has to say so, because approving a request
 * silently does nothing until one is chosen.
 */
describe('ExamSettings', () => {
  it('warns while invoicing is not yet configured', async () => {
    renderPanel();
    expect(await screen.findByText(/invoices cannot be created without one/i)).toBeInTheDocument();
  });

  it('drops the warning once a target is set', async () => {
    api.getExamSettings.mockResolvedValue(
      settings({ waveIncomeAccountId: 'income-1', invoicingReady: true }),
    );
    renderPanel();

    await screen.findByLabelText(/Gmail search/i);
    expect(screen.queryByText(/invoices cannot be created without one/i)).not.toBeInTheDocument();
  });

  it('offers products and income accounts as alternatives', async () => {
    renderPanel();
    await screen.findByLabelText(/Invoice line comes from/i);

    expect(screen.getByRole('option', { name: /Eye Exam/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Professional Fees' })).toBeInTheDocument();
  });

  it('choosing a product clears any income account, and vice versa', async () => {
    api.getExamSettings.mockResolvedValue(
      settings({ waveIncomeAccountId: 'income-1', invoicingReady: true }),
    );
    renderPanel();

    const select = await screen.findByLabelText(/Invoice line comes from/i);
    await userEvent.selectOptions(select, 'product:prod-1');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.saveExamSettings).toHaveBeenCalled());
    const payload = api.saveExamSettings.mock.calls[0][0];
    expect(payload.waveServiceProductId).toBe('prod-1');
    expect(payload.waveIncomeAccountId).toBe('');
  });

  it('explains that the Gmail search gates everything', async () => {
    renderPanel();
    await screen.findByLabelText(/Gmail search/i);

    expect(screen.getByText(/Nothing is polled while this is empty/i)).toBeInTheDocument();
  });

  it('saves the edited workflow settings', async () => {
    renderPanel();

    const query = await screen.findByLabelText(/Gmail search/i);
    await userEvent.clear(query);
    await userEvent.type(query, 'label:bookings');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.saveExamSettings).toHaveBeenCalled());
    expect(api.saveExamSettings.mock.calls[0][0].gmailQuery).toBe('label:bookings');
  });

  it('still renders when Wave cannot be reached', async () => {
    api.getWaveInvoiceTargets.mockRejectedValue(new Error('Wave is not configured.'));
    renderPanel();

    expect(await screen.findByText(/Couldn't load your Wave products/i)).toBeInTheDocument();
    // The rest of the panel remains usable.
    expect(screen.getByLabelText(/Gmail search/i)).toBeInTheDocument();
  });

  it('surfaces a rejected save', async () => {
    api.saveExamSettings.mockRejectedValue(new Error('Choose either a service product or an income account, not both.'));
    renderPanel();

    await screen.findByLabelText(/Gmail search/i);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    // "not both" also appears in the field's own help text, so match the
    // toast's full message rather than the phrase.
    expect(
      await screen.findByText('Choose either a service product or an income account, not both.'),
    ).toBeInTheDocument();
  });
});
