import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { InvoiceEditor } from '../../src/components/InvoiceEditor';
import { ToastProvider } from '../../src/components/Toast';

vi.mock('../../src/api/client');
import * as api from '../../src/api/client';

beforeEach(() => {
  for (const fn of Object.values(api)) (fn as any).mockReset?.();
  api.updateInvoiceLineItems.mockResolvedValue({ success: true, request: {} as any });
});

function renderEditor(lineItems = [{ description: 'Eye exam', quantity: 1, unitPrice: 120 }], onSaved = vi.fn()) {
  render(
    <ToastProvider>
      <InvoiceEditor examRequestId="req-1" lineItems={lineItems} currency="CAD" onSaved={onSaved} />
    </ToastProvider>,
  );
  return onSaved;
}

/** Spec: only a local draft is editable, and an invoice always has at least one line. */
describe('InvoiceEditor', () => {
  it('shows the existing lines and their total', () => {
    renderEditor([
      { description: 'Eye exam', quantity: 1, unitPrice: 120 },
      { description: 'Form fee', quantity: 2, unitPrice: 15 },
    ]);

    expect(screen.getByDisplayValue('Eye exam')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Form fee')).toBeInTheDocument();
    expect(screen.getByText('150.00 CAD')).toBeInTheDocument();
  });

  it('starts with a blank line when there is nothing to edit', () => {
    renderEditor([]);
    expect(screen.getByLabelText('Line 1 description')).toHaveValue('');
  });

  it('recalculates the total as figures change', async () => {
    renderEditor();

    const qty = screen.getByLabelText('Line 1 quantity');
    await userEvent.clear(qty);
    await userEvent.type(qty, '3');

    expect(screen.getByText('360.00 CAD')).toBeInTheDocument();
  });

  it('adds and removes lines', async () => {
    renderEditor();

    await userEvent.click(screen.getByRole('button', { name: 'Add line' }));
    expect(screen.getByLabelText('Line 2 description')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Remove line 2' }));
    expect(screen.queryByLabelText('Line 2 description')).not.toBeInTheDocument();
  });

  it('will not let the last line be removed', () => {
    renderEditor();
    // An invoice with no lines cannot be created in Wave.
    expect(screen.getByRole('button', { name: 'Remove line 1' })).toBeDisabled();
  });

  it('saves the edited lines', async () => {
    const onSaved = renderEditor();

    const description = screen.getByLabelText('Line 1 description');
    await userEvent.clear(description);
    await userEvent.type(description, 'Contact lens fitting');
    await userEvent.click(screen.getByRole('button', { name: 'Save invoice' }));

    await waitFor(() =>
      expect(api.updateInvoiceLineItems).toHaveBeenCalledWith('req-1', [
        { description: 'Contact lens fitting', quantity: 1, unitPrice: 120 },
      ]),
    );
    expect(onSaved).toHaveBeenCalled();
  });

  it('refuses to save a line with no description', async () => {
    renderEditor();

    await userEvent.clear(screen.getByLabelText('Line 1 description'));
    await userEvent.click(screen.getByRole('button', { name: 'Save invoice' }));

    expect(await screen.findByText(/Every line needs a description/i)).toBeInTheDocument();
    expect(api.updateInvoiceLineItems).not.toHaveBeenCalled();
  });

  it('refuses a quantity of zero', async () => {
    renderEditor();

    const qty = screen.getByLabelText('Line 1 quantity');
    await userEvent.clear(qty);
    await userEvent.type(qty, '0');
    await userEvent.click(screen.getByRole('button', { name: 'Save invoice' }));

    expect(await screen.findByText(/Quantity must be greater than zero/i)).toBeInTheDocument();
    expect(api.updateInvoiceLineItems).not.toHaveBeenCalled();
  });

  it('surfaces a rejection from the server', async () => {
    api.updateInvoiceLineItems.mockRejectedValue(new Error('already been created in Wave'));
    const onSaved = renderEditor();

    await userEvent.click(screen.getByRole('button', { name: 'Save invoice' }));

    expect(await screen.findByText(/already been created in Wave/i)).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });
});
