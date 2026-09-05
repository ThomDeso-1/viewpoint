import { useEffect, useState, useCallback, type ReactNode } from 'react';
import {
  getReceipt,
  extractReceipt,
  updateReceipt,
  checkDuplicates,
  type ReceiptRow,
} from '../shared/api';
import { Screen } from '../ui/Screen';
import { PageHeader } from '../ui/PageHeader';
import { Button } from '../ui/Button';
import { Notice } from '../ui/Notice';

type ExtractionState = 'loading' | 'extracting' | 'ready' | 'error' | 'no-key';

interface Props {
  id: string;
  headerTitle: string;
  headerRight?: ReactNode;
  /** Extra controls below the form (the batch flow's prev / skip). */
  footer?: ReactNode;
  onBack: () => void;
  onApproved: (receipt: ReceiptRow) => void;
}

/**
 * The extract → review → approve form for a single receipt.
 * Shared by the single-receipt review page and the batch review flow.
 */
export function ReceiptReviewForm({ id, headerTitle, headerRight, footer, onBack, onApproved }: Props) {
  const [receipt, setReceipt] = useState<ReceiptRow | null>(null);
  const [state, setState] = useState<ExtractionState>('loading');
  const [errorMsg, setErrorMsg] = useState('');

  // Editable fields
  const [receiptDate, setReceiptDate] = useState('');
  const [vendor, setVendor] = useState('');
  const [summary, setSummary] = useState('');
  const [totalAmount, setTotalAmount] = useState('');
  const [taxAmount, setTaxAmount] = useState('');
  const [currency, setCurrency] = useState('CAD');

  // Extraction metadata
  const [confidence, setConfidence] = useState('');
  const [reconciled, setReconciled] = useState(true);

  // Warnings
  const [duplicateWarnings, setDuplicateWarnings] = useState<string[]>([]);
  const [validationWarnings, setValidationWarnings] = useState<string[]>([]);

  // Submitting
  const [submitting, setSubmitting] = useState(false);

  // ── Load receipt ──
  const loadReceipt = useCallback(async () => {
    try {
      const r = await getReceipt(id);
      setReceipt(r);

      if (r.status === 'extracted' || r.status === 'reviewed') {
        populateFromReceipt(r);
        setState('ready');
      } else if (r.status === 'captured') {
        // Need extraction
        setState('extracting');
        try {
          const extracted = await extractReceipt(id);
          setReceipt(extracted);
          populateFromReceipt(extracted);
          setState('ready');
        } catch (err: any) {
          if (err.message?.includes('No Claude API key')) {
            setState('no-key');
          } else {
            setErrorMsg(err.message || 'Extraction failed.');
            setState('error');
          }
        }
      } else {
        // uploaded, failed, etc — just show read-only data
        populateFromReceipt(r);
        setState('ready');
      }
    } catch {
      setErrorMsg('Could not load receipt.');
      setState('error');
    }
  }, [id]);

  useEffect(() => {
    loadReceipt();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // ── Check duplicates when data is ready ──
  useEffect(() => {
    if (state === 'ready') {
      checkDuplicates(id).then((d) => setDuplicateWarnings(d.warnings)).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, id]);

  // ── Populate fields ──
  function populateFromReceipt(r: ReceiptRow) {
    setReceiptDate(r.receipt_date?.slice(0, 10) || '');
    setVendor(r.vendor || '');
    setSummary(r.summary || '');
    setTotalAmount(r.total_amount != null ? r.total_amount.toFixed(2) : '');
    setTaxAmount(r.tax_amount != null ? r.tax_amount.toFixed(2) : '');
    setCurrency(r.currency || 'CAD');

    // Parse extracted JSON for confidence / reconciliation
    if (r.extracted_json) {
      try {
        const ext = JSON.parse(r.extracted_json);
        setConfidence(ext.confidence || '');
        const totalTax = (ext.taxes || []).reduce((s: number, t: any) => s + t.amount, 0);
        setReconciled(Math.abs(ext.subtotal + totalTax - ext.total) < 0.02);
      } catch {
        // ignore
      }
    }

    runValidation(r.receipt_date?.slice(0, 10) || '', r.currency || 'CAD', r.total_amount);
  }

  function populateDefaults() {
    setVendor('');
    setSummary('');
    setTotalAmount('');
    setTaxAmount('');
    setCurrency('CAD');
    setConfidence('');
    setState('ready');
  }

  // ── Validation ──
  function runValidation(date: string, cur: string, total: number | null) {
    const warnings: string[] = [];
    if (date) {
      const d = new Date(date + 'T00:00:00');
      if (d > new Date()) warnings.push('Receipt date is in the future.');
      const oneYearAgo = new Date();
      oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
      if (d < oneYearAgo) warnings.push('Receipt date is more than a year old.');
    }
    const c = (cur || '').trim().toUpperCase();
    if (c && c !== 'CAD') warnings.push(`Currency is ${c}, not CAD — confirm this is correct.`);
    if (total != null && total <= 0) warnings.push('Total is zero or negative.');
    setValidationWarnings(warnings);
  }

  // Update validation when fields change
  useEffect(() => {
    if (state === 'ready') {
      runValidation(receiptDate, currency, parseFloat(totalAmount) || null);
    }
  }, [receiptDate, currency, totalAmount, state]);

  // ── Approve ──
  async function handleApprove() {
    const parsedTotal = totalAmount.trim() === '' ? null : parseFloat(totalAmount);
    const parsedTax = taxAmount.trim() === '' ? null : parseFloat(taxAmount);

    if (Number.isNaN(parsedTotal) || Number.isNaN(parsedTax)) {
      setErrorMsg('Total and tax must be valid numbers.');
      return;
    }

    setSubmitting(true);
    try {
      const updated = await updateReceipt(id, {
        receipt_date: receiptDate ? receiptDate + 'T00:00:00.000Z' : undefined,
        vendor: vendor || undefined,
        summary: summary || undefined,
        total_amount: parsedTotal,
        tax_amount: parsedTax,
        currency: currency || 'CAD',
        status: 'reviewed',
      });
      onApproved(updated);
    } catch (err: any) {
      setErrorMsg(err.message || 'Save failed.');
    } finally {
      setSubmitting(false);
    }
  }

  // ── Retry extraction ──
  async function handleRetryExtraction() {
    setState('extracting');
    setErrorMsg('');
    try {
      const extracted = await extractReceipt(id);
      setReceipt(extracted);
      populateFromReceipt(extracted);
      setState('ready');
    } catch (err: any) {
      setErrorMsg(err.message || 'Extraction failed.');
      setState('error');
    }
  }

  // ── Render helpers ──
  const isEditable = receipt?.status === 'captured' || receipt?.status === 'extracted' || receipt?.status === 'reviewed';

  if (state === 'loading') {
    return (
      <Screen width="read" className="vp-review">
        <div className="loading-screen"><div className="loading-spinner" /></div>
      </Screen>
    );
  }

  return (
    <Screen width="read" className="vp-review">
      <PageHeader title={headerTitle} onBack={onBack} actions={headerRight} />

      {receipt && (
        <div className="vp-review-image">
          <img src={`/images/${receipt.primary_image}`} alt="Receipt" />
        </div>
      )}

      {state === 'extracting' && (
        <div className="vp-review-extracting">
          <div className="loading-spinner" />
          <p className="vp-review-extracting-text">Extracting receipt data…</p>
          <p className="vp-muted">This usually takes a few seconds.</p>
        </div>
      )}

      {state === 'error' && (
        <div className="vp-review-blocked">
          <p className="vp-review-blocked-title">Extraction Failed</p>
          <p className="vp-muted">{errorMsg}</p>
          <div className="vp-review-blocked-actions">
            <Button variant="secondary" onClick={populateDefaults}>
              Enter Manually
            </Button>
            <Button variant="primary" onClick={handleRetryExtraction}>
              Retry
            </Button>
          </div>
        </div>
      )}

      {state === 'no-key' && (
        <div className="vp-review-blocked">
          <p className="vp-review-blocked-title">No Claude API Key</p>
          <p className="vp-muted">
            Add your Claude API key in Settings to enable automatic extraction, or enter the receipt
            data manually.
          </p>
          <Button variant="primary" onClick={populateDefaults}>
            Enter Manually
          </Button>
        </div>
      )}

      {state === 'ready' && (
        <>
          <div className="vp-stack vp-stack--sm vp-mb-4">
            {confidence && (
              <Notice tone={confidence === 'high' ? 'success' : confidence === 'medium' ? 'warning' : 'danger'}>
                {confidence === 'high'
                  ? 'High confidence — fields look good.'
                  : confidence === 'medium'
                    ? 'Medium confidence — please double-check the fields.'
                    : 'Low confidence — the image was hard to read.'}
              </Notice>
            )}
            {!reconciled && (
              <Notice tone="warning">Subtotal + tax doesn't match total — check the amounts.</Notice>
            )}
            {duplicateWarnings.map((w, i) => (
              <Notice key={i} tone="warning">
                {w}
              </Notice>
            ))}
            {validationWarnings.map((w, i) => (
              <Notice key={`v${i}`} tone="warning">
                {w}
              </Notice>
            ))}
            {errorMsg && <Notice tone="danger">{errorMsg}</Notice>}
          </div>

          <div className="vp-review-fields">
            <label className="vp-review-field">
              <span>Date</span>
              <input
                type="date"
                value={receiptDate}
                onChange={(e) => setReceiptDate(e.target.value)}
                disabled={!isEditable}
              />
            </label>

            <label className="vp-review-field">
              <span>Vendor</span>
              <input
                type="text"
                value={vendor}
                onChange={(e) => setVendor(e.target.value)}
                placeholder="Business name"
                disabled={!isEditable}
              />
            </label>

            <label className="vp-review-field">
              <span>Description</span>
              <input
                type="text"
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                placeholder="What was purchased"
                disabled={!isEditable}
              />
            </label>

            <label className="vp-review-field">
              <span>Total</span>
              <span className="vp-review-money">
                <span aria-hidden="true">$</span>
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  value={totalAmount}
                  onChange={(e) => setTotalAmount(e.target.value)}
                  placeholder="0.00"
                  disabled={!isEditable}
                />
              </span>
            </label>

            <label className="vp-review-field">
              <span>Tax</span>
              <span className="vp-review-money">
                <span aria-hidden="true">$</span>
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  value={taxAmount}
                  onChange={(e) => setTaxAmount(e.target.value)}
                  placeholder="0.00"
                  disabled={!isEditable}
                />
              </span>
            </label>

            <label className="vp-review-field">
              <span>Currency</span>
              <input
                type="text"
                className="vp-review-short"
                value={currency}
                onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                placeholder="CAD"
                maxLength={3}
                disabled={!isEditable}
              />
            </label>
          </div>

          {isEditable && (
            <Button
              variant="primary"
              block
              className="vp-review-approve"
              onClick={handleApprove}
              loading={submitting}
            >
              Approve &amp; Upload
            </Button>
          )}

          {!isEditable && receipt && (
            <Notice tone={receipt.status === 'uploaded' ? 'success' : 'warning'}>
              {receipt.status === 'uploaded'
                ? 'This receipt has been uploaded to Wave.'
                : receipt.status === 'failed'
                  ? `Upload failed: ${receipt.last_error || 'Unknown error'}`
                  : `Status: ${receipt.status}`}
            </Notice>
          )}
        </>
      )}

      {footer}
    </Screen>
  );
}
