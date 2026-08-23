import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { makeReceipt } from '../helpers/fixtures';
import { ReceiptReviewForm } from '../../src/components/ReceiptReviewForm';

// Automock: every named export of api/client becomes a vi.fn() returning
// undefined by default, configured per-test below.
vi.mock('../../src/api/client');
import * as api from '../../src/api/client';

/**
 * Spec (CONVERSION-PLAN.md "Receipt Review Page"):
 *  - Auto-triggers extraction for `captured` receipts; shows the form
 *    directly for `extracted`/`reviewed` (no re-extraction).
 *  - Confidence banner from the extraction result (high/medium/low).
 *  - Reconciliation check: subtotal + tax ≈ total within $0.02.
 *  - Validation warnings: future date, >1yr old, non-CAD currency,
 *    zero/negative total.
 *  - Duplicate warnings surfaced from the duplicates check.
 *  - Approve button sets status to 'reviewed' and calls onApproved.
 *  - Fallback: "Enter Manually" when there's no API key or extraction
 *    fails.
 *  - Non-editable once uploaded/failed: fields disabled, no Approve
 *    button, status explanation banner instead.
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
});

afterEach(() => {
  vi.useRealTimers();
});

function noop() {}

describe('ReceiptReviewForm', () => {
  it('shows a loading spinner while the receipt is being fetched', async () => {
    api.getReceipt.mockReturnValue(new Promise(() => {})); // never resolves
    const { container } = render(
      <ReceiptReviewForm id="r1" headerTitle="Review" onBack={noop} onApproved={noop} />,
    );
    expect(container.querySelector('.loading-spinner')).toBeInTheDocument();
  });

  it('auto-triggers extraction for a captured receipt and shows the extracting state meanwhile', async () => {
    const captured = makeReceipt({ status: 'captured' });
    api.getReceipt.mockResolvedValue(captured);
    let resolveExtract: (v: unknown) => void;
    api.extractReceipt.mockReturnValue(new Promise((r) => (resolveExtract = r)));

    render(<ReceiptReviewForm id="r1" headerTitle="Review" onBack={noop} onApproved={noop} />);

    await waitFor(() => expect(api.extractReceipt).toHaveBeenCalledWith('r1'));
    expect(screen.getByText(/extracting receipt data/i)).toBeInTheDocument();
  });

  it('does NOT re-trigger extraction for an already-extracted receipt', async () => {
    api.getReceipt.mockResolvedValue(
      makeReceipt({ status: 'extracted', vendor: 'Costco', total_amount: 55.5 }),
    );

    render(<ReceiptReviewForm id="r1" headerTitle="Review" onBack={noop} onApproved={noop} />);

    await waitFor(() => expect(screen.getByLabelText('Vendor')).toHaveValue('Costco'));
    expect(api.extractReceipt).not.toHaveBeenCalled();
  });

  it('populates fields from a successful extraction', async () => {
    api.getReceipt.mockResolvedValue(makeReceipt({ status: 'captured' }));
    api.extractReceipt.mockResolvedValue(
      makeReceipt({
        status: 'extracted',
        vendor: 'The Coffee Spot',
        summary: 'Coffee',
        total_amount: 6.22,
        tax_amount: 0.72,
        currency: 'CAD',
        extracted_json: JSON.stringify(extractedPayload()),
      }),
    );

    render(<ReceiptReviewForm id="r1" headerTitle="Review" onBack={noop} onApproved={noop} />);

    await waitFor(() => expect(screen.getByLabelText('Vendor')).toHaveValue('The Coffee Spot'));
    // "Total"/"Tax" labels wrap a "$" prefix too, so match by substring.
    expect(screen.getByLabelText(/total/i)).toHaveValue(6.22);
    expect(screen.getByLabelText(/^tax/i)).toHaveValue(0.72);
  });

  it('shows the "no Claude API key" fallback and lets the user enter manually', async () => {
    api.getReceipt.mockResolvedValue(makeReceipt({ status: 'captured' }));
    api.extractReceipt.mockRejectedValue(new Error('No Claude API key configured. Add it in Settings.'));

    render(<ReceiptReviewForm id="r1" headerTitle="Review" onBack={noop} onApproved={noop} />);

    await waitFor(() => expect(screen.getByText(/no claude api key/i)).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /enter manually/i }));

    expect(screen.getByLabelText('Vendor')).toHaveValue('');
    expect(screen.getByRole('button', { name: /approve & upload/i })).toBeInTheDocument();
  });

  it('shows an extraction error with Retry and Enter Manually actions', async () => {
    api.getReceipt.mockResolvedValue(makeReceipt({ status: 'captured' }));
    api.extractReceipt.mockRejectedValueOnce(new Error('Claude API rate limit reached.'));

    render(<ReceiptReviewForm id="r1" headerTitle="Review" onBack={noop} onApproved={noop} />);

    await waitFor(() => expect(screen.getByText(/extraction failed/i)).toBeInTheDocument());
    expect(screen.getByText(/rate limit reached/i)).toBeInTheDocument();

    api.extractReceipt.mockResolvedValueOnce(
      makeReceipt({ status: 'extracted', vendor: 'Retried Co' }),
    );
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(screen.getByLabelText('Vendor')).toHaveValue('Retried Co'));
  });

  it('shows a confidence banner matching the extraction result', async () => {
    api.getReceipt.mockResolvedValue(
      makeReceipt({
        status: 'extracted',
        extracted_json: JSON.stringify(extractedPayload({ confidence: 'low' })),
      }),
    );

    render(<ReceiptReviewForm id="r1" headerTitle="Review" onBack={noop} onApproved={noop} />);

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

    render(<ReceiptReviewForm id="r1" headerTitle="Review" onBack={noop} onApproved={noop} />);

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

    render(<ReceiptReviewForm id="r1" headerTitle="Review" onBack={noop} onApproved={noop} />);

    await waitFor(() => expect(screen.getByLabelText('Vendor')).toBeInTheDocument());
    expect(screen.queryByText(/doesn't match total/i)).not.toBeInTheDocument();
  });

  describe('validation warnings', () => {
    it('warns when the receipt date is in the future', async () => {
      api.getReceipt.mockResolvedValue(makeReceipt({ status: 'extracted', receipt_date: '2026-12-25T00:00:00.000Z' }));
      render(<ReceiptReviewForm id="r1" headerTitle="Review" onBack={noop} onApproved={noop} />);
      await waitFor(() => expect(screen.getByText(/date is in the future/i)).toBeInTheDocument());
    });

    it('warns when the receipt date is more than a year old', async () => {
      api.getReceipt.mockResolvedValue(makeReceipt({ status: 'extracted', receipt_date: '2024-01-01T00:00:00.000Z' }));
      render(<ReceiptReviewForm id="r1" headerTitle="Review" onBack={noop} onApproved={noop} />);
      await waitFor(() => expect(screen.getByText(/more than a year old/i)).toBeInTheDocument());
    });

    it('warns when the currency is not CAD', async () => {
      api.getReceipt.mockResolvedValue(makeReceipt({ status: 'extracted', currency: 'USD' }));
      render(<ReceiptReviewForm id="r1" headerTitle="Review" onBack={noop} onApproved={noop} />);
      await waitFor(() => expect(screen.getByText(/currency is usd, not cad/i)).toBeInTheDocument());
    });

    it('warns when the total is zero or negative', async () => {
      api.getReceipt.mockResolvedValue(makeReceipt({ status: 'extracted', total_amount: 0 }));
      render(<ReceiptReviewForm id="r1" headerTitle="Review" onBack={noop} onApproved={noop} />);
      await waitFor(() => expect(screen.getByText(/zero or negative/i)).toBeInTheDocument());
    });

    it('shows no validation warnings for a clean, recent, CAD, positive-total receipt', async () => {
      api.getReceipt.mockResolvedValue(
        makeReceipt({ status: 'extracted', vendor: 'V', receipt_date: '2026-06-10T00:00:00.000Z', currency: 'CAD', total_amount: 10 }),
      );
      render(<ReceiptReviewForm id="r1" headerTitle="Review" onBack={noop} onApproved={noop} />);
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

    render(<ReceiptReviewForm id="r1" headerTitle="Review" onBack={noop} onApproved={noop} />);

    await waitFor(() => expect(screen.getByText(/matches an existing receipt/i)).toBeInTheDocument());
  });

  it('approving sends the edited fields with status=reviewed and calls onApproved', async () => {
    api.getReceipt.mockResolvedValue(
      makeReceipt({ status: 'extracted', vendor: 'Old Vendor', total_amount: 10, receipt_date: '2026-06-10T00:00:00.000Z' }),
    );
    api.updateReceipt.mockResolvedValue(makeReceipt({ status: 'reviewed', vendor: 'New Vendor' }));
    const onApproved = vi.fn();

    render(<ReceiptReviewForm id="r1" headerTitle="Review" onBack={noop} onApproved={onApproved} />);
    await waitFor(() => expect(screen.getByLabelText('Vendor')).toHaveValue('Old Vendor'));

    const vendorInput = screen.getByLabelText('Vendor');
    await userEvent.clear(vendorInput);
    await userEvent.type(vendorInput, 'New Vendor');
    await userEvent.click(screen.getByRole('button', { name: /approve & upload/i }));

    await waitFor(() => expect(api.updateReceipt).toHaveBeenCalled());
    const [id, payload] = api.updateReceipt.mock.calls[0];
    expect(id).toBe('r1');
    expect(payload.status).toBe('reviewed');
    expect(payload.vendor).toBe('New Vendor');
    expect(payload.total_amount).toBe(10);

    await waitFor(() => expect(onApproved).toHaveBeenCalledWith(expect.objectContaining({ vendor: 'New Vendor' })));
  });

  it('disables the Approve button while submitting', async () => {
    api.getReceipt.mockResolvedValue(makeReceipt({ status: 'extracted', vendor: 'V' }));
    let resolveUpdate: (v: unknown) => void;
    api.updateReceipt.mockReturnValue(new Promise((r) => (resolveUpdate = r)));

    render(<ReceiptReviewForm id="r1" headerTitle="Review" onBack={noop} onApproved={noop} />);
    await waitFor(() => expect(screen.getByLabelText('Vendor')).toHaveValue('V'));

    const approveBtn = screen.getByRole('button', { name: /approve & upload/i });
    await userEvent.click(approveBtn);

    expect(screen.getByRole('button', { name: /saving/i })).toBeDisabled();
    resolveUpdate!(makeReceipt({ status: 'reviewed' }));
  });

  it('a non-editable (already uploaded) receipt shows disabled fields, no Approve button, and a status banner', async () => {
    api.getReceipt.mockResolvedValue(makeReceipt({ status: 'uploaded', vendor: 'Done Co' }));

    render(<ReceiptReviewForm id="r1" headerTitle="Review" onBack={noop} onApproved={noop} />);

    await waitFor(() => expect(screen.getByLabelText('Vendor')).toHaveValue('Done Co'));
    expect(screen.getByLabelText('Vendor')).toBeDisabled();
    expect(screen.queryByRole('button', { name: /approve & upload/i })).not.toBeInTheDocument();
    expect(screen.getByText(/uploaded to wave/i)).toBeInTheDocument();
  });

  it('a failed receipt shows the last error in its status banner', async () => {
    api.getReceipt.mockResolvedValue(
      makeReceipt({ status: 'failed', vendor: 'V', last_error: 'Wave token expired' }),
    );

    render(<ReceiptReviewForm id="r1" headerTitle="Review" onBack={noop} onApproved={noop} />);

    await waitFor(() => expect(screen.getByText(/upload failed: wave token expired/i)).toBeInTheDocument());
  });
});
