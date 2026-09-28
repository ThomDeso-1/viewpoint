import { useEffect, useState, useCallback, type ReactNode } from 'react';
import {
  getReceipt,
  getSettings,
  extractReceipt,
  updateReceipt,
  checkDuplicates,
  receiptImageUrl,
  type ReceiptRow,
} from '../shared/api';
import { Screen } from '../ui/Screen';
import { PageHeader } from '../ui/PageHeader';
import { Button } from '../ui/Button';
import { Notice } from '../ui/Notice';
import { Icon } from '../ui/Icon';

/**
 *  loading   — fetching the row
 *  reading   — uploaded, Claude is still reading it in the background
 *  unreadable — Claude gave up (needsAttention); retry or type it in
 *  no-key    — no Claude key, so nothing will read it; type it in
 *  ready     — fields shown, editable
 *  error     — couldn't load the receipt at all
 */
type ViewState = 'loading' | 'reading' | 'unreadable' | 'no-key' | 'ready' | 'error';

/** How often to look again while a receipt is still being read. */
export const READING_POLL_MS = 2500;

interface Props {
  id: string;
  headerTitle: string;
  headerRight?: ReactNode;
  /** Extra controls below the form (the batch flow's prev / skip). */
  footer?: ReactNode;
  onBack: () => void;
  onSaved: (receipt: ReceiptRow) => void;
}

/**
 * One receipt: its photo, the fields Claude filled in, and how sure it
 * was. Receipts are read automatically on upload — there is no approval
 * step. Saving here records the operator's corrections and marks the
 * receipt "checked"; nothing is sent anywhere.
 *
 * Shared by the single-receipt page and the "check uncertain" batch flow.
 */
export function ReceiptReviewForm({ id, headerTitle, headerRight, footer, onBack, onSaved }: Props) {
  const [receipt, setReceipt] = useState<ReceiptRow | null>(null);
  const [state, setState] = useState<ViewState>('loading');
  const [errorMsg, setErrorMsg] = useState('');

  // Editable fields
  const [receiptDate, setReceiptDate] = useState('');
  const [vendor, setVendor] = useState('');
  const [summary, setSummary] = useState('');
  const [totalAmount, setTotalAmount] = useState('');
  const [taxAmount, setTaxAmount] = useState('');
  const [currency, setCurrency] = useState('CAD');

  // Extraction metadata
  const [reconciled, setReconciled] = useState(true);

  // Warnings
  const [duplicateWarnings, setDuplicateWarnings] = useState<string[]>([]);
  const [validationWarnings, setValidationWarnings] = useState<string[]>([]);

  const [submitting, setSubmitting] = useState(false);
  const [retrying, setRetrying] = useState(false);

  // ── Load / route by status ──
  const show = useCallback((r: ReceiptRow, hasKey: boolean) => {
    setReceipt(r);
    if (r.status === 'captured') {
      setState(hasKey ? 'reading' : 'no-key');
    } else if (r.status === 'needsAttention') {
      setState('unreadable');
    } else {
      populateFromReceipt(r);
      setState('ready');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getReceipt(id), getSettings().catch(() => null)])
      .then(([r, settings]) => {
        if (!cancelled) show(r, settings?.hasClaudeKey !== false);
      })
      .catch(() => {
        if (cancelled) return;
        setErrorMsg('Could not load receipt.');
        setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [id, show]);

  // ── While Claude reads it, look again every few seconds ──
  useEffect(() => {
    if (state !== 'reading') return;
    const t = setInterval(() => {
      getReceipt(id)
        .then((r) => {
          if (r.status !== 'captured') show(r, true);
        })
        .catch(() => {});
    }, READING_POLL_MS);
    return () => clearInterval(t);
  }, [state, id, show]);

  // ── Check duplicates when data is ready ──
  useEffect(() => {
    if (state === 'ready') {
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

    // Reconciliation needs the line-level numbers, which only live in the blob.
    if (r.extracted_json) {
      try {
        const ext = JSON.parse(r.extracted_json);
        const totalTax = (ext.taxes || []).reduce((s: number, t: any) => s + t.amount, 0);
        setReconciled(Math.abs(ext.subtotal + totalTax - ext.total) < 0.02);
      } catch {
        // ignore
      }
    }

    runValidation(r.receipt_date?.slice(0, 10) || '', r.currency || 'CAD', r.total_amount);
  }

  /** Type it in by hand — for a receipt Claude can't (or won't) read. */
  function enterManually() {
    setReceiptDate(new Date().toLocaleDateString('en-CA'));
    setVendor('');
    setSummary('');
    setTotalAmount('');
    setTaxAmount('');
    setCurrency('CAD');
    setErrorMsg('');
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

  useEffect(() => {
    if (state === 'ready') {
      runValidation(receiptDate, currency, parseFloat(totalAmount) || null);
    }
  }, [receiptDate, currency, totalAmount, state]);

  // ── Save (marks it checked) ──
  async function handleSave() {
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
      onSaved(updated);
    } catch (err: any) {
      setErrorMsg(err.message || 'Save failed.');
    } finally {
      setSubmitting(false);
    }
  }

  // ── Try reading it again ──
  async function handleRetry() {
    setRetrying(true);
    setErrorMsg('');
    try {
      const extracted = await extractReceipt(id);
      show(extracted, true);
    } catch (err: any) {
      setErrorMsg(err.message || "Still couldn't read it.");
    } finally {
      setRetrying(false);
    }
  }

  if (state === 'loading') {
    return (
      <Screen width="read" className="vp-review">
        <div className="loading-screen"><div className="loading-spinner" /></div>
      </Screen>
    );
  }

  const confidence = receipt?.status === 'extracted' ? receipt.confidence : null;

  return (
    <Screen width="read" className="vp-review">
      <PageHeader title={headerTitle} onBack={onBack} actions={headerRight} />

      {receipt && (
        <>
          <div className="vp-review-image">
            <a href={receiptImageUrl(id)} target="_blank" rel="noreferrer" title="Open full size">
              <img src={receiptImageUrl(id)} alt="Receipt" />
            </a>
          </div>
          <div className="vp-review-image-actions">
            <Button variant="ghost" size="sm" href={receiptImageUrl(id)} target="_blank" rel="noreferrer">
              Open full size
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={<Icon name="download" size={14} />}
              // The server answers with Content-Disposition: attachment.
              href={receiptImageUrl(id, { download: true })}
            >
              Download
            </Button>
          </div>
        </>
      )}

      {state === 'reading' && (
        <div className="vp-review-extracting">
          <div className="loading-spinner" />
          <p className="vp-review-extracting-text">Reading receipt…</p>
          <p className="vp-muted">The fields fill in on their own — usually a few seconds.</p>
        </div>
      )}

      {state === 'error' && (
        <div className="vp-review-blocked">
          <p className="vp-review-blocked-title">Couldn't load this receipt</p>
          <p className="vp-muted">{errorMsg}</p>
        </div>
      )}

      {state === 'unreadable' && (
        <div className="vp-review-blocked">
          <p className="vp-review-blocked-title">Couldn't read this receipt</p>
          <p className="vp-muted">{errorMsg || receipt?.last_error || 'The image may be blurry or cut off.'}</p>
          <div className="vp-review-blocked-actions">
            <Button variant="secondary" onClick={enterManually}>
              Enter Manually
            </Button>
            <Button variant="primary" onClick={handleRetry} loading={retrying}>
              Try Again
            </Button>
          </div>
        </div>
      )}

      {state === 'no-key' && (
        <div className="vp-review-blocked">
          <p className="vp-review-blocked-title">No Claude API Key</p>
          <p className="vp-muted">
            Add your Claude API key in Settings and receipts are read automatically, or enter this
            one by hand.
          </p>
          <Button variant="primary" onClick={enterManually}>
            Enter Manually
          </Button>
        </div>
      )}

      {state === 'ready' && (
        <>
          <div className="vp-stack vp-stack--sm vp-mb-4">
            {receipt?.status === 'reviewed' && <Notice tone="success">Checked — you've confirmed these fields.</Notice>}
            {confidence && (
              <Notice tone={confidence === 'high' ? 'success' : confidence === 'medium' ? 'warning' : 'danger'}>
                {confidence === 'high'
                  ? 'High confidence — fields look good.'
                  : confidence === 'medium'
                    ? 'Medium confidence — please double-check the fields.'
                    : 'Low confidence — the image was hard to read. Check every field.'}
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
              <input type="date" value={receiptDate} onChange={(e) => setReceiptDate(e.target.value)} />
            </label>

            <label className="vp-review-field">
              <span>Vendor</span>
              <input
                type="text"
                value={vendor}
                onChange={(e) => setVendor(e.target.value)}
                placeholder="Business name"
              />
            </label>

            <label className="vp-review-field">
              <span>Description</span>
              <input
                type="text"
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                placeholder="What was purchased"
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
              />
            </label>
          </div>

          <Button variant="primary" block className="vp-review-approve" onClick={handleSave} loading={submitting}>
            {receipt?.status === 'reviewed' ? 'Save Changes' : 'Save as Checked'}
          </Button>
        </>
      )}

      {footer}
    </Screen>
  );
}
