import type { ReceiptRow as Receipt } from '../shared/api';
import { StatusBadge } from '../shared/StatusBadge';

interface Props {
  receipt: Receipt;
  onTap: () => void;
  onDelete: () => void;
}

export function ReceiptRow({ receipt, onTap, onDelete }: Props) {
  const date = new Date(receipt.receipt_date);
  const formattedDate = date.toLocaleDateString('en-CA', {
    month: 'short',
    day: 'numeric',
  });

  const amount =
    receipt.total_amount != null
      ? new Intl.NumberFormat('en-CA', { style: 'currency', currency: receipt.currency || 'CAD' }).format(
          receipt.total_amount,
        )
      : null;

  return (
    <div className="receipt-card" onClick={onTap} role="button" tabIndex={0}>
      <div className="receipt-thumb">
        <img
          src={`/images/${receipt.primary_image}`}
          alt={receipt.vendor || 'Receipt'}
          loading="lazy"
        />
      </div>
      <div className="receipt-info">
        <div className="receipt-top-row">
          <span className="receipt-vendor">{receipt.vendor || 'Unprocessed'}</span>
          <StatusBadge status={receipt.status} />
        </div>
        <div className="receipt-meta">
          <span className="receipt-date">{formattedDate}</span>
          {amount && <span className="receipt-amount">{amount}</span>}
        </div>
        {receipt.summary && <p className="receipt-summary">{receipt.summary}</p>}
        {receipt.last_error && (
          <p className="receipt-error">{receipt.last_error}</p>
        )}
      </div>
      <button className="receipt-delete" onClick={(e) => { e.stopPropagation(); onDelete(); }} title="Delete receipt">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M2 4h12M5.33 4V2.67a.67.67 0 01.67-.67h4a.67.67 0 01.67.67V4M6.67 7.33v4M9.33 7.33v4M3.33 4l.67 9.33a1.33 1.33 0 001.33 1.34h5.34a1.33 1.33 0 001.33-1.34L12.67 4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}
