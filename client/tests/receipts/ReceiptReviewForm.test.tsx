import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { makeReceipt } from '../helpers/fixtures';
import { ReceiptReviewForm, READING_POLL_MS } from '../../src/receipts/ReceiptReviewForm';

// Automock: every named export of api/client becomes a vi.fn() returning
// undefined by default, configured per-test below.
vi.mock('../../src/shared/api');
import * as api from '../../src/shared/api';

/**
 * Spec (CONVERSION-PLAN.md "Receipt Review Page", as revised by
 * migration 010 — read on upload, no approval gate):
 *  - A `captured` receipt is being read by the server; the screen shows
 *    "Reading receipt…" and looks again until it's done. It never
 *    triggers extraction itself.
 *  - A `needsAttention` receipt (Claude couldn't read it) offers Try
 *    Again (manual extract) and Enter Manually.
 *  - Confidence banner from the stored confidence (high/medium/low).
 *  - Reconciliation check: subtotal + tax ≈ total within $0.02.
 *  - Validation warnings: future date, >1yr old, non-CAD currency,
 *    zero/negative total.
 *  - Duplicate warnings surfaced from the duplicates check.
 *  - "Save as Checked" sets status to 'reviewed' and calls onSaved.
 *    Every receipt stays editable; nothing is sent anywhere.
 *  - Fallback: "Enter Manually" when there's no API key.
 *  - The photo can be opened full size or downloaded via its stable
 *    id-based link.
 */
function extractedPayload(overrides: Record<string, unknown> = {}) {
  return {
    confidence: 'high',
    subtotal: 20,
    taxes: [{ type: 'HST', rate: 0.13, amount: 2.6 }],
    total: 22.6,
    ...overrides,
  };
}

beforeEach(() => {
  vi.setSystemTime(new Date('2026-06-15T12:00:00Z'));
  for (const fn of Object.values(api)) fn.mockReset();
  api.checkDuplicates.mockResolvedValue({ warnings: [] });
  api.getSettings.mockResolvedValue({ hasClaudeKey: true } as any);
  api.receiptImageUrl.mockImplementation(
    (id: string, o: { download?: boolean } = {}) => `/api/receipts/${id}/image${o.download ? '?download=1' : ''}`,
  );
});

afterEach(() => {
  vi.useRealTimers();
});

function noop() {}
const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter>{children}</MemoryRouter>;

describe('ReceiptReviewForm', () => {
  it('shows a loading spinner while the receipt is being fetched', async () => {
    api.getReceipt.mockReturnValue(new Promise(() => {})); // never resolves
    const { container } = render(
      <ReceiptReviewForm id="r1" headerTitle="Review" onBack={noop} onSaved={noop} />,
      { wrapper },
    );
    expect(container.querySelector('.loading-spinner')).toBeInTheDocument();
  });

  it('shows "Reading receipt…" for a captured receipt and never triggers extraction itself', async () => {
    api.getReceipt.mockResolvedValue(makeReceipt({ status: 'captured' }));

    render(<ReceiptReviewForm id="r1" headerTitle="Review" onBack={noop} onSaved={noop} />, { wrapper });

    await waitFor(() => expect(screen.getByText(/reading receipt/i)).toBeInTheDocument());
    expect(api.extractReceipt).not.toHaveBeenCalled();
  });

  it('fills the fields in on its own once the server has read it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.getReceipt
      .mockResolvedValueOnce(makeReceipt({ status: 'captured' }))
      .mockResolvedValue(
        makeReceipt({
          status: 'extracted',
          vendor: 'Costco',
          total_amount: 22.6,
          confidence: 'high',
          receipt_date: '2026-06-01T00:00:00.000Z',
        }),
      );

    render(<ReceiptReviewForm id="r1" headerTitle="Review" onBack={noop} onSaved={noop} />, { wrapper });
    await waitFor(() => expect(screen.getByText(/reading receipt/i)).toBeInTheDocument());

    await vi.advanceTimersByTimeAsync(READING_POLL_MS + 50);

    await waitFor(() => expect(screen.getByLabelText('Vendor')).toHaveValue('Costco'));
    expect(screen.getByDisplayValue('22.60')).toBeInTheDocument();
    expect(screen.getByDisplayValue('2026-06-01')).toBeInTheDocument();
    expect(api.extractReceipt).not.toHaveBeenCalled();
  });

  it('shows the form straight away for an already-read receipt', async () => {
    api.getReceipt.mockResolvedValue(makeReceipt({ status: 'extracted', vendor: 'Staples' }));

    render(<ReceiptReviewForm id="r1" headerTitle="Review" onBack={noop} onSaved={noop} />, { wrapper });

    await waitFor(() => expect(screen.getByLabelText('Vendor')).toHaveValue('Staples'));
    expect(api.extractReceipt).not.toHaveBeenCalled();
  });

  it('shows the "no Claude API key" fallback and lets the user enter manually', async () => {
    api.getSettings.mockResolvedValue({ hasClaudeKey: false } as any);
    api.getReceipt.mockResolvedValue(makeReceipt({ status: 'captured' }));

    render(<ReceiptReviewForm id="r1" headerTitle="Review" onBack={noop} onSaved={noop} />, { wrapper });

    await waitFor(() => expect(screen.getByText(/no claude api key/i)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /enter manually/i }));
    expect(screen.getByLabelText('Vendor')).toBeInTheDocument();
  });

  it("offers Try Again and Enter Manually for a receipt Claude couldn't read", async () => {
    api.getReceipt.mockResolvedValue(makeReceipt({ status: 'needsAttention', last_error: 'Image too blurry' }));
    api.extractReceipt.mockResolvedValue(makeReceipt({ status: 'extracted', vendor: 'Second Try', confidence: 'medium' }));

    render(<ReceiptReviewForm id="r1" headerTitle="Review" onBack={noop} onSaved={noop} />, { wrapper });

    await waitFor(() => expect(screen.getByText(/couldn't read this receipt/i)).toBeInTheDocument());
    expect(screen.getByText('Image too blurry')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /enter manually/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(screen.getByLabelText('Vendor')).toHaveValue('Second Try'));
    expect(screen.getByText(/medium confidence/i)).toBeInTheDocument();
  });

  it('keeps the unreadable state and shows the error when Try Again fails', async () => {
    api.getReceipt.mockResolvedValue(makeReceipt({ status: 'needsAttention' }));
    api.extractReceipt.mockRejectedValue(new Error('Claude is overloaded.'));

    render(<ReceiptReviewForm id="r1" headerTitle="Review" onBack={noop} onSaved={noop} />, { wrapper });
    await userEvent.click(await screen.findByRole('button', { name: /try again/i }));

    await waitFor(() => expect(screen.getByText('Claude is overloaded.')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /enter manually/i })).toBeInTheDocument();
  });

  it('links to the full-size photo and a download, by receipt id', async () => {
    api.getReceipt.mockResolvedValue(makeReceipt({ status: 'extracted', vendor: 'V' }));

    render(<ReceiptReviewForm id="r1" headerTitle="Review" onBack={noop} onSaved={noop} />, { wrapper });

    await waitFor(() => expect(screen.getByLabelText('Vendor')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: /open full size/i })).toHaveAttribute('href', '/api/receipts/r1/image');
    expect(screen.getByRole('link', { name: /download/i })).toHaveAttribute('href', '/api/receipts/r1/image?download=1');
  });

  it('shows a confidence banner matching the extraction result', async () => {
    api.getReceipt.mockResolvedValue(
      makeReceipt({
        status: 'extracted',
        confidence: 'low',
        extracted_json: JSON.stringify(extractedPayload({ confidence: 'low' })),
      }),
    );

    render(<ReceiptReviewForm id="r1" headerTitle="Review" onBack={noop} onSaved={noop} />, { wrapper });

    await waitFor(() => expect(screen.getByText(/low confidence/i)).toBeInTheDocument());
  });

  it('shows a reconciliation warning when subtotal + tax does not match total', async () => {
    api.getReceipt.mockResolvedValue(
      makeReceipt({
        status: 'extracted',
        extracted_json: JSON.stringify(
          extractedPayload({ subtotal: 20, taxes: [{ type: 'HST', rate: 0.13, amount: 2.6 }], total: 50 }),
        ),
      }),
    );

    render(<ReceiptReviewForm id="r1" headerTitle="Review" onBack={noop} onSaved={noop} />, { wrapper });

    await waitFor(() =>
      expect(screen.getByText(/doesn't match total/i)).toBeInTheDocument(),
    );
  });

  it('does not show a reconciliation warning when subtotal + tax matches total within 2 cents', async () => {
    api.getReceipt.mockResolvedValue(
      makeReceipt({
        status: 'extracted',
        vendor: 'V',
        extracted_json: JSON.stringify(extractedPayload({ subtotal: 20, taxes: [{ type: 'HST', rate: 0.13, amount: 2.6 }], total: 22.61 })),
      }),
    );

    render(<ReceiptReviewForm id="r1" headerTitle="Review" onBack={noop} onSaved={noop} />, { wrapper });

    await waitFor(() => expect(screen.getByLabelText('Vendor')).toBeInTheDocument());
    expect(screen.queryByText(/doesn't match total/i)).not.toBeInTheDocument();
  });

  describe('validation warnings', () => {
    it('warns when the receipt date is in the future', async () => {
      api.getReceipt.mockResolvedValue(makeReceipt({ status: 'extracted', receipt_date: '2026-12-25T00:00:00.000Z' }));
      render(<ReceiptReviewForm id="r1" headerTitle="Review" onBack={noop} onSaved={noop} />, { wrapper });
      await waitFor(() => expect(screen.getByText(/date is in the future/i)).toBeInTheDocument());
    });

    it('warns when the receipt date is more than a year old', async () => {
      api.getReceipt.mockResolvedValue(makeReceipt({ status: 'extracted', receipt_date: '2024-01-01T00:00:00.000Z' }));
      render(<ReceiptReviewForm id="r1" headerTitle="Review" onBack={noop} onSaved={noop} />, { wrapper });
      await waitFor(() => expect(screen.getByText(/more than a year old/i)).toBeInTheDocument());
    });

    it('warns when the currency is not CAD', async () => {
      api.getReceipt.mockResolvedValue(makeReceipt({ status: 'extracted', currency: 'USD' }));
      render(<ReceiptReviewForm id="r1" headerTitle="Review" onBack={noop} onSaved={noop} />, { wrapper });
      await waitFor(() => expect(screen.getByText(/currency is usd, not cad/i)).toBeInTheDocument());
    });

    it('warns when the total is zero or negative', async () => {
      api.getReceipt.mockResolvedValue(makeReceipt({ status: 'extracted', total_amount: 0 }));
      render(<ReceiptReviewForm id="r1" headerTitle="Review" onBack={noop} onSaved={noop} />, { wrapper });
      await waitFor(() => expect(screen.getByText(/zero or negative/i)).toBeInTheDocument());
    });

    it('shows no validation warnings for a clean, recent, CAD, positive-total receipt', async () => {
      api.getReceipt.mockResolvedValue(
        makeReceipt({ status: 'extracted', vendor: 'V', receipt_date: '2026-06-10T00:00:00.000Z', currency: 'CAD', total_amount: 10 }),
      );
      render(<ReceiptReviewForm id="r1" headerTitle="Review" onBack={noop} onSaved={noop} />, { wrapper });
      await waitFor(() => expect(screen.getByLabelText('Vendor')).toBeInTheDocument());
      expect(screen.queryByText(/date is in the future/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/year old/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/not cad/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/zero or negative/i)).not.toBeInTheDocument();
    });
  });

  it('surfaces duplicate warnings from the duplicates check', async () => {
    api.getReceipt.mockResolvedValue(makeReceipt({ status: 'extracted' }));
    api.checkDuplicates.mockResolvedValue({ warnings: ['This image matches an existing receipt (Costco).'] });

    render(<ReceiptReviewForm id="r1" headerTitle="Review" onBack={noop} onSaved={noop} />, { wrapper });

    await waitFor(() => expect(screen.getByText(/matches an existing receipt/i)).toBeInTheDocument());
  });

  it('saving sends the edited fields with status=reviewed and calls onSaved', async () => {
    api.getReceipt.mockResolvedValue(
      makeReceipt({ status: 'extracted', vendor: 'Old Vendor', total_amount: 10, receipt_date: '2026-06-10T00:00:00.000Z' }),
    );
    api.updateReceipt.mockResolvedValue(makeReceipt({ status: 'reviewed', vendor: 'New Vendor' }));
    const onSaved = vi.fn();

    render(<ReceiptReviewForm id="r1" headerTitle="Review" onBack={noop} onSaved={onSaved} />, { wrapper });
    await waitFor(() => expect(screen.getByLabelText('Vendor')).toHaveValue('Old Vendor'));

    const vendorInput = screen.getByLabelText('Vendor');
    await userEvent.clear(vendorInput);
    await userEvent.type(vendorInput, 'New Vendor');
    await userEvent.click(screen.getByRole('button', { name: /save as checked/i }));

    await waitFor(() => expect(api.updateReceipt).toHaveBeenCalled());
    const [id, payload] = api.updateReceipt.mock.calls[0];
    expect(id).toBe('r1');
    expect(payload.status).toBe('reviewed');
    expect(payload.vendor).toBe('New Vendor');
    expect(payload.total_amount).toBe(10);

    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ vendor: 'New Vendor' })));
  });

  it('disables the Save button while submitting', async () => {
    api.getReceipt.mockResolvedValue(makeReceipt({ status: 'extracted', vendor: 'V' }));
    let resolveUpdate: (v: unknown) => void;
    api.updateReceipt.mockReturnValue(new Promise((r) => (resolveUpdate = r)));

    render(<ReceiptReviewForm id="r1" headerTitle="Review" onBack={noop} onSaved={noop} />, { wrapper });
    await waitFor(() => expect(screen.getByLabelText('Vendor')).toHaveValue('V'));

    await userEvent.click(screen.getByRole('button', { name: /save as checked/i }));

    expect(screen.getByRole('button', { name: /save as checked/i })).toBeDisabled();
    resolveUpdate!(makeReceipt({ status: 'reviewed' }));
  });

  it('a checked receipt stays editable and says so', async () => {
    api.getReceipt.mockResolvedValue(makeReceipt({ status: 'reviewed', vendor: 'Done Co', confidence: 'low' }));

    render(<ReceiptReviewForm id="r1" headerTitle="Review" onBack={noop} onSaved={noop} />, { wrapper });

    await waitFor(() => expect(screen.getByLabelText('Vendor')).toHaveValue('Done Co'));
    expect(screen.getByLabelText('Vendor')).toBeEnabled();
    expect(screen.getByText(/checked — you've confirmed/i)).toBeInTheDocument();
    // Claude's doubt no longer applies once a person has checked it.
    expect(screen.queryByText(/low confidence/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
    expect(screen.queryByText(/wave/i)).not.toBeInTheDocument();
  });
});
