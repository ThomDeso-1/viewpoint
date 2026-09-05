import { useEffect, useState } from 'react';
import {
  getExamSettings,
  saveExamSettings,
  getWaveInvoiceTargets,
  testExamSourceFolder,
  type ExamSettings as Data,
  type FolderTestResult,
  type WaveInvoiceTargets,
} from '../shared/api';
import { useToast } from '../shared/Toast';
import { EmailTemplateSettings } from './EmailTemplateSettings';

/**
 * The exam-request workflow settings: which folder to scan for patient
 * files, how confident an extraction must be, invoicing defaults, and
 * reminder wording inputs.
 */
export function ExamSettings() {
  const [form, setForm] = useState<Data | null>(null);
  const [targets, setTargets] = useState<WaveInvoiceTargets | null>(null);
  const [targetsError, setTargetsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [folderTest, setFolderTest] = useState<FolderTestResult | null>(null);
  const { showToast } = useToast();

  const handleTestFolder = async () => {
    if (!form) return;
    setTesting(true);
    setFolderTest(null);
    try {
      setFolderTest(await testExamSourceFolder(form.sourceFolder));
    } catch (err) {
      setFolderTest({ ok: false, error: (err as Error).message });
    } finally {
      setTesting(false);
    }
  };

  const load = async () => {
    try {
      setForm(await getExamSettings());
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
      await saveExamSettings(form);
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
        Files in the patient files folder are read every minute, drafted automatically, and held for
        your approval. Nothing is sent to a patient or posted to Wave until you approve it.
      </p>

      <label className="wizard-field-label">
        Patient files folder
        <input
          className="auth-input"
          value={form.sourceFolder}
          onChange={(e) => setForm({ ...form, sourceFolder: e.target.value })}
          placeholder="/Users/you/Dropbox/Viewpoint/patient-files"
        />
        <small className="muted">
          An absolute path to a folder on this computer — typically one a Dropbox, iCloud or Google
          Drive desktop app keeps synced. Scanned recursively for .docx, .xlsx, .csv, .pdf, .txt and
          .eml files; a file is re-read only if its contents change. Nothing is scanned while this is
          empty.
        </small>
      </label>

      <button className="btn-secondary" onClick={handleTestFolder} disabled={testing || !form.sourceFolder}>
        {testing ? 'Testing…' : 'Test folder'}
      </button>

      {folderTest && (
        <div className={`banner ${folderTest.ok ? 'banner-info' : 'banner-warning'}`}>
          {folderTest.ok ? (
            <>
              Found {folderTest.fileCount} file{folderTest.fileCount === 1 ? '' : 's'}
              {folderTest.byExtension && Object.keys(folderTest.byExtension).length > 0 && (
                <>
                  {' '}(
                  {Object.entries(folderTest.byExtension)
                    .map(([ext, n]) => `${n} ${ext}`)
                    .join(', ')}
                  )
                </>
              )}
              .
              {folderTest.sampleNames && folderTest.sampleNames.length > 0 && (
                <> e.g. {folderTest.sampleNames.slice(0, 5).join(', ')}</>
              )}
              {folderTest.tooLarge && folderTest.tooLarge.length > 0 && (
                <> — {folderTest.tooLarge.length} file(s) skipped for being too large.</>
              )}
            </>
          ) : (
            <>Couldn't read that folder: {folderTest.error}</>
          )}
        </div>
      )}

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
        Business name
        <input
          className="auth-input"
          value={form.businessName}
          onChange={(e) => setForm({ ...form, businessName: e.target.value })}
          placeholder="Viewpoint Vision Care"
        />
        <small className="muted">Appears in the reminder email sent to patients.</small>
      </label>

      <label className="wizard-field-label">
        Timezone
        <input
          className="auth-input"
          value={form.businessTimezone}
          onChange={(e) => setForm({ ...form, businessTimezone: e.target.value })}
          placeholder="America/Toronto"
        />
        <small className="muted">Used to write appointment times in reminder emails.</small>
      </label>

      <label className="wizard-field-label">
        Default reminder time
        <select
          className="wizard-select"
          value={
            [24, 48, 72, 168, 336].includes(form.reminderLeadHours)
              ? String(form.reminderLeadHours)
              : 'custom'
          }
          onChange={(e) => setForm({ ...form, reminderLeadHours: Number(e.target.value) })}
        >
          {![24, 48, 72, 168, 336].includes(form.reminderLeadHours) && (
            <option value="custom">{form.reminderLeadHours} hours before</option>
          )}
          <option value="24">1 day before</option>
          <option value="48">2 days before</option>
          <option value="72">3 days before</option>
          <option value="168">1 week before</option>
          <option value="336">2 weeks before</option>
        </select>
        <small className="muted">
          When patient reminder emails go out. You can override this per patient on the request card
          before approving.
        </small>
      </label>

      <button className="btn-primary" onClick={handleSave} disabled={saving}>
        {saving ? 'Saving…' : 'Save'}
      </button>

      <EmailTemplateSettings />
    </section>
  );
}
