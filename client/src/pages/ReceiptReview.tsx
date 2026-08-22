import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  getReceipt,
  extractReceipt,
  updateReceipt,
  checkDuplicates,
  type ReceiptRow,
} from '../api/client';

type ExtractionState = 'loading' | 'extracting' | 'ready' | 'error' | 'no-key';

export function ReceiptReview() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

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
    if (!id) return;
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
  }, [loadReceipt]);

  // ── Check duplicates when data is ready ──
  useEffect(() => {
    if (state === 'ready' && id) {
      checkDuplicates(id).then((d) => setDuplicateWarnings(d.warnings)).catch(() => {});
    }
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
    if (!id) return;
    setSubmitting(true);
    try {
      await updateReceipt(id, {
        receipt_date: receiptDate ? receiptDate + 'T00:00:00.000Z' : undefined,
        vendor: vendor || undefined,
        summary: summary || undefined,
        total_amount: totalAmount ? parseFloat(totalAmount) : null,
        tax_amount: taxAmount ? parseFloat(taxAmount) : null,
        currency: currency || 'CAD',
        status: 'reviewed',
      });
      navigate('/', { replace: true });
    } catch (err: any) {
      setErrorMsg(err.message || 'Save failed.');
    } finally {
      setSubmitting(false);
    }
  }

  // ── Retry extraction ──
  async function handleRetryExtraction() {
    if (!id) return;
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
      <div className="review-page">
        <div className="loading-screen"><div className="loading-spinner" /></div>
      </div>
    );
  }

  return (
    <div className="review-page">
      <header className="review-header">
        <button className="review-back" onClick={() => navigate(-1)}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 4l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <h1 className="review-title">Review Receipt</h1>
        <div style={{ width: 36 }} />
      </header>

      <main className="review-content">
        {/* Image preview */}
        {receipt && (
          <div className="review-image">
            <img
              src={`/images/${receipt.primary_image}`}
              alt="Receipt"
            />
          </div>
        )}

        {/* Extracting state */}
        {state === 'extracting' && (
          <div className="review-extracting">
            <div className="loading-spinner" />
            <p className="review-extracting-text">Extracting receipt data…</p>
            <p className="review-extracting-sub">This usually takes a few seconds.</p>
          </div>
        )}

        {/* Error state */}
        {state === 'error' && (
          <div className="review-error-block">
            <p className="review-error-title">Extraction Failed</p>
            <p className="review-error-msg">{errorMsg}</p>
            <div className="review-error-actions">
              <button className="btn-secondary" onClick={populateDefaults}>
                Enter Manually
              </button>
              <button className="btn-primary" onClick={handleRetryExtraction}>
                Retry
              </button>
            </div>
          </div>
        )}

        {/* No API key */}
        {state === 'no-key' && (
          <div className="review-error-block">
            <p className="review-error-title">No Claude API Key</p>
            <p className="review-error-msg">
              Add your Claude API key in Settings to enable automatic extraction,
              or enter the receipt data manually.
            </p>
            <button className="btn-primary" onClick={populateDefaults}>
              Enter Manually
            </button>
          </div>
        )}

        {/* Ready — form */}
        {state === 'ready' && (
          <>
            {/* Confidence banner */}
            {confidence && (
              <div className={`banner banner-${confidence}`}>
                {confidence === 'high'
                  ? 'High confidence — fields look good'
                  : confidence === 'medium'
                    ? 'Medium confidence — please double-check the fields'
                    : 'Low confidence — image was hard to read'}
              </div>
            )}

            {/* Reconciliation warning */}
            {!reconciled && (
              <div className="banner banner-warning">
                Subtotal + tax doesn't match total — check the amounts
              </div>
            )}

            {/* Duplicate warnings */}
            {duplicateWarnings.map((w, i) => (
              <div key={i} className="banner banner-warning">{w}</div>
            ))}

            {/* Validation warnings */}
            {validationWarnings.map((w, i) => (
              <div key={`v${i}`} className="banner banner-caution">{w}</div>
            ))}

            {/* Editable fields */}
            <div className="review-fields">
              <label className="field-row">
                <span className="field-label">Date</span>
                <input
                  type="date"
                  value={receiptDate}
                  onChange={(e) => setReceiptDate(e.target.value)}
                  disabled={!isEditable}
                  className="field-input"
                />
              </label>

              <label className="field-row">
                <span className="field-label">Vendor</span>
                <input
                  type="text"
                  value={vendor}
                  onChange={(e) => setVendor(e.target.value)}
                  placeholder="Business name"
                  disabled={!isEditable}
                  className="field-input"
                />
              </label>

              <label className="field-row">
                <span className="field-label">Description</span>
                <input
                  type="text"
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  placeholder="What was purchased"
                  disabled={!isEditable}
                  className="field-input"
                />
              </label>

              <label className="field-row">
                <span className="field-label">Total</span>
                <div className="field-money">
                  <span className="field-currency-sign">$</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    value={totalAmount}
                    onChange={(e) => setTotalAmount(e.target.value)}
                    placeholder="0.00"
                    disabled={!isEditable}
                    className="field-input"
                  />
                </div>
              </label>

              <label className="field-row">
                <span className="field-label">Tax</span>
                <div className="field-money">
                  <span className="field-currency-sign">$</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    value={taxAmount}
                    onChange={(e) => setTaxAmount(e.target.value)}
                    placeholder="0.00"
                    disabled={!isEditable}
                    className="field-input"
                  />
                </div>
              </label>

              <label className="field-row">
                <span className="field-label">Currency</span>
                <input
                  type="text"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value.toUpperCase())}
                  placeholder="CAD"
                  maxLength={3}
                  disabled={!isEditable}
                  className="field-input field-input-short"
                />
              </label>
            </div>

            {/* Approve button */}
            {isEditable && (
              <button
                className="approve-button"
                onClick={handleApprove}
                disabled={submitting}
              >
                {submitting ? 'Saving…' : 'Approve & Upload'}
              </button>
            )}

            {/* Status info for non-editable */}
            {!isEditable && receipt && (
              <div className={`banner banner-${receipt.status === 'uploaded' ? 'high' : 'warning'}`}>
                {receipt.status === 'uploaded'
                  ? 'This receipt has been uploaded to Wave.'
                  : receipt.status === 'failed'
                    ? `Upload failed: ${receipt.last_error || 'Unknown error'}`
                    : `Status: ${receipt.status}`}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
