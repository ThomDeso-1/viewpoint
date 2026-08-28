import { useEffect, useState } from 'react';
import {
  getPracticeSettings,
  savePracticeSettings,
  getWaveInvoiceTargets,
  type PracticeSettings as Data,
  type WaveInvoiceTargets,
} from '../shared/api';
import { useToast } from '../shared/Toast';

/**
 * The exam-request workflow settings: which emails to read, how confident
 * an extraction must be, invoicing defaults, and reminder wording inputs.
 */
export function PracticeSettings() {
  const [form, setForm] = useState<Data | null>(null);
  const [targets, setTargets] = useState<WaveInvoiceTargets | null>(null);
  const [targetsError, setTargetsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { showToast } = useToast();

  const load = async () => {
    try {
      setForm(await getPracticeSettings());
    } catch {
      setForm(null);
    }

    // Needs a live Wave connection, so it can legitimately fail while the
    // rest of this panel still works.
    try {
      setTargets(await getWaveInvoiceTargets());
      setTargetsError(null);
    } catch (err) {
      setTargetsError((err as Error).message);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleSave = async () => {
    if (!form) return;
    setSaving(true);
    try {
      await savePracticeSettings(form);
      showToast('Saved.', 'success');
      await load();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  if (!form) return null;

  /** Product and income account are alternatives — picking one clears the other. */
  const chooseInvoiceTarget = (value: string) => {
    if (value.startsWith('product:')) {
      setForm({ ...form, waveServiceProductId: value.slice('product:'.length), waveIncomeAccountId: '' });
    } else if (value.startsWith('account:')) {
      setForm({ ...form, waveIncomeAccountId: value.slice('account:'.length), waveServiceProductId: '' });
    } else {
      setForm({ ...form, waveIncomeAccountId: '', waveServiceProductId: '' });
    }
  };

  const selectedTarget = form.waveServiceProductId
    ? `product:${form.waveServiceProductId}`
    : form.waveIncomeAccountId
      ? `account:${form.waveIncomeAccountId}`
      : '';

  return (
    <section className="settings-section">
      <h2 className="settings-section-title">Exam Requests</h2>

      <p className="settings-help">
        New requests are read from Gmail every minute, drafted automatically, and held for your
        approval. Nothing is sent to a patient or posted to Wave until you approve it.
      </p>

      <label className="wizard-field-label">
        Gmail search
        <input
          className="auth-input"
          value={form.gmailQuery}
          onChange={(e) => setForm({ ...form, gmailQuery: e.target.value })}
          placeholder="label:exam-requests"
        />
        <small className="muted">
          Which emails count as exam requests. A dedicated Gmail label is the most reliable —
          everything matching is sent to Claude to read, so keep this tight. Nothing is polled while
          this is empty.
        </small>
      </label>

      <label className="wizard-field-label">
        Minimum confidence
        <input
          className="auth-input"
          type="number"
          min="0"
          max="1"
          step="0.05"
          value={form.minConfidence}
          onChange={(e) => setForm({ ...form, minConfidence: Number(e.target.value) })}
        />
        <small className="muted">
          Between 0 and 1. Below this, a request is held for manual review instead of being drafted —
          usually meaning the email wasn't really a booking. Default 0.6.
        </small>
      </label>

      <h3 className="settings-subheading">Invoicing</h3>

      {!form.invoicingReady && (
        <div className="banner banner-warning">
          Choose a service product or income account below — invoices cannot be created without one.
        </div>
      )}

      {targetsError ? (
        <p className="settings-help">
          Couldn't load your Wave products and accounts: {targetsError}
        </p>
      ) : (
        <>
          <label className="wizard-field-label" htmlFor="invoice-target">
            Invoice line comes from
          </label>
          <select
            id="invoice-target"
            className="wizard-select"
            value={selectedTarget}
            onChange={(e) => chooseInvoiceTarget(e.target.value)}
          >
            <option value="">Not set</option>
            {targets && targets.products.length > 0 && (
              <optgroup label="Service products">
                {targets.products.map((p) => (
                  <option key={p.id} value={`product:${p.id}`}>
                    {p.name}
                    {p.unitPrice != null ? ` — $${p.unitPrice}` : ''}
                  </option>
                ))}
              </optgroup>
            )}
            {targets && targets.income.length > 0 && (
              <optgroup label="Income accounts">
                {targets.income.map((a) => (
                  <option key={a.id} value={`account:${a.id}`}>
                    {a.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
          <small className="muted">
            A saved Wave product carries its own name and price; an income account is the plainer
            option if you don't keep products. One or the other, not both.
          </small>
        </>
      )}

      <label className="wizard-field-label">
        Default exam fee
        <input
          className="auth-input"
          type="number"
          min="0"
          step="0.01"
          value={form.examFeeAmount}
          onChange={(e) => setForm({ ...form, examFeeAmount: Number(e.target.value) })}
        />
        <small className="muted">
          Used for the first line of a drafted invoice. You can edit the lines on any request before
          approving it.
        </small>
      </label>

      <h3 className="settings-subheading">Reminders</h3>

      <label className="wizard-field-label">
        Practice name
        <input
          className="auth-input"
          value={form.clinicName}
          onChange={(e) => setForm({ ...form, clinicName: e.target.value })}
          placeholder="Viewpoint Optometry"
        />
        <small className="muted">Appears in the reminder email sent to patients.</small>
      </label>

      <label className="wizard-field-label">
        Timezone
        <input
          className="auth-input"
          value={form.clinicTimezone}
          onChange={(e) => setForm({ ...form, clinicTimezone: e.target.value })}
          placeholder="America/Toronto"
        />
        <small className="muted">Used to write appointment times in reminder emails.</small>
      </label>

      <label className="wizard-field-label">
        Send reminders this many hours ahead
        <input
          className="auth-input"
          type="number"
          min="1"
          step="1"
          value={form.reminderLeadHours}
          onChange={(e) => setForm({ ...form, reminderLeadHours: Number(e.target.value) })}
        />
      </label>

      <button className="btn-primary" onClick={handleSave} disabled={saving}>
        {saving ? 'Saving…' : 'Save'}
      </button>
    </section>
  );
}
