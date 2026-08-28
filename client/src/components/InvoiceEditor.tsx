import { useState } from 'react';
import { updateInvoiceLineItems, type InvoiceLineItem } from '../api/client';
import { useToast } from './Toast';

interface Props {
  examRequestId: string;
  lineItems: InvoiceLineItem[];
  currency: string;
  onSaved: () => void;
}

/**
 * Edits the lines on a drafted invoice.
 *
 * Only offered while the invoice is still a local draft: once it exists
 * in Wave, Wave holds the authoritative copy and editing belongs there.
 */
export function InvoiceEditor({ examRequestId, lineItems, currency, onSaved }: Props) {
  const [items, setItems] = useState<InvoiceLineItem[]>(
    lineItems.length > 0 ? lineItems : [{ description: '', quantity: 1, unitPrice: 0 }],
  );
  const [saving, setSaving] = useState(false);
  const { showToast } = useToast();

  const total = items.reduce((sum, i) => sum + (i.quantity || 0) * (i.unitPrice || 0), 0);

  const update = (index: number, patch: Partial<InvoiceLineItem>) => {
    setItems(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  };

  const addLine = () => setItems([...items, { description: '', quantity: 1, unitPrice: 0 }]);

  const removeLine = (index: number) => {
    // An invoice with no lines can't be created, so never remove the last.
    if (items.length === 1) return;
    setItems(items.filter((_, i) => i !== index));
  };

  const handleSave = async () => {
    if (items.some((i) => !i.description.trim())) {
      showToast('Every line needs a description.', 'error');
      return;
    }
    if (items.some((i) => i.quantity <= 0)) {
      showToast('Quantity must be greater than zero.', 'error');
      return;
    }

    setSaving(true);
    try {
      await updateInvoiceLineItems(examRequestId, items);
      showToast('Invoice updated.', 'success');
      onSaved();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="invoice-editor">
      <table className="invoice-table">
        <thead>
          <tr>
            <th>Description</th>
            <th className="numeric">Qty</th>
            <th className="numeric">Unit price</th>
            <th className="numeric">Amount</th>
            <th aria-label="Remove" />
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <tr key={index}>
              <td>
                <input
                  aria-label={`Line ${index + 1} description`}
                  value={item.description}
                  onChange={(e) => update(index, { description: e.target.value })}
                  placeholder="Comprehensive eye examination"
                />
              </td>
              <td className="numeric">
                <input
                  aria-label={`Line ${index + 1} quantity`}
                  type="number"
                  min="1"
                  step="1"
                  value={item.quantity}
                  onChange={(e) => update(index, { quantity: Number(e.target.value) })}
                />
              </td>
              <td className="numeric">
                <input
                  aria-label={`Line ${index + 1} unit price`}
                  type="number"
                  min="0"
                  step="0.01"
                  value={item.unitPrice}
                  onChange={(e) => update(index, { unitPrice: Number(e.target.value) })}
                />
              </td>
              <td className="numeric">
                {((item.quantity || 0) * (item.unitPrice || 0)).toFixed(2)}
              </td>
              <td>
                <button
                  className="link-button"
                  onClick={() => removeLine(index)}
                  disabled={items.length === 1}
                  aria-label={`Remove line ${index + 1}`}
                >
                  ×
                </button>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td colSpan={3} className="numeric">
              <strong>Total</strong>
            </td>
            <td className="numeric">
              <strong>
                {total.toFixed(2)} {currency}
              </strong>
            </td>
            <td />
          </tr>
        </tfoot>
      </table>

      <div className="request-actions">
        <button className="secondary" onClick={addLine}>
          Add line
        </button>
        <button className="primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save invoice'}
        </button>
      </div>
    </div>
  );
}
