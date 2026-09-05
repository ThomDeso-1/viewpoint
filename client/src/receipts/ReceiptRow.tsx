import type { ReceiptRow as Receipt } from '../shared/api';
import { StatusBadge } from '../shared/StatusBadge';
import { formatMoney } from '../shared/format';
import { Icon } from '../ui/Icon';

interface Props {
  receipt: Receipt;
  onTap: () => void;
  onDelete: () => void;
}

export function ReceiptRow({ receipt, onTap, onDelete }: Props) {
  const date = new Date(receipt.receipt_date).toLocaleDateString('en-CA', {
    month: 'short',
    day: 'numeric',
  });
  const amount = receipt.total_amount != null ? formatMoney(receipt.total_amount, receipt.currency) : null;

  return (
    <div className="vp-receipt-row">
      <button type="button" className="vp-receipt-row-main" onClick={onTap}>
        <span className="vp-receipt-thumb">
          <img src={`/images/${receipt.primary_image}`} alt={receipt.vendor || 'Receipt'} loading="lazy" />
        </span>
        <span className="vp-receipt-info">
          <span className="vp-receipt-top">
            <span className="vp-receipt-vendor">{receipt.vendor || 'Unprocessed'}</span>
            <StatusBadge status={receipt.status} />
          </span>
          <span className="vp-receipt-meta">
            <span>{date}</span>
            {amount && <span className="vp-receipt-amount">{amount}</span>}
          </span>
          {receipt.summary && <span className="vp-receipt-summary">{receipt.summary}</span>}
          {receipt.last_error && <span className="vp-receipt-err">{receipt.last_error}</span>}
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
