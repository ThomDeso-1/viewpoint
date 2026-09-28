import type { ReceiptRow as Receipt } from '../shared/api';
import { formatMoney } from '../shared/format';
import { Pill } from '../ui/Pill';
import { Icon } from '../ui/Icon';
import { receiptBadge, receiptLocalDate } from './receipt-status';

interface Props {
  receipt: Receipt;
  onTap: () => void;
  onDelete: () => void;
}

export function ReceiptRow({ receipt, onTap, onDelete }: Props) {
  const reading = receipt.status === 'captured';
  const date = receiptLocalDate(receipt.receipt_date).toLocaleDateString('en-CA', {
    month: 'short',
    day: 'numeric',
  });
  const amount = receipt.total_amount != null ? formatMoney(receipt.total_amount, receipt.currency) : null;
  const badge = receiptBadge(receipt);

  return (
    <div className="vp-receipt-row">
      <button type="button" className="vp-receipt-row-main" onClick={onTap}>
        <span className="vp-receipt-thumb">
          <img src={`/images/${receipt.primary_image}`} alt={receipt.vendor || 'Receipt'} loading="lazy" />
        </span>
        <span className="vp-receipt-info">
          <span className="vp-receipt-top">
            <span className="vp-receipt-vendor">
              {receipt.vendor || (reading ? 'Reading receipt…' : 'Unknown vendor')}
            </span>
            <Pill tone={badge.tone}>{badge.label}</Pill>
          </span>
          <span className="vp-receipt-meta">
            {/* Until it's read, the only date there is is the upload time. */}
            <span>{reading ? `Uploaded ${date}` : date}</span>
            {amount && <span className="vp-receipt-amount">{amount}</span>}
          </span>
          {receipt.summary && <span className="vp-receipt-summary">{receipt.summary}</span>}
          {receipt.status === 'needsAttention' && receipt.last_error && (
            <span className="vp-receipt-err">{receipt.last_error}</span>
          )}
        </span>
      </button>
      <button
        type="button"
        className="vp-receipt-del"
        onClick={onDelete}
        title="Delete receipt"
        aria-label="Delete receipt"
      >
        <Icon name="trash" size={16} />
      </button>
    </div>
  );
}
