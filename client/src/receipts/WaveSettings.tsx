import { useState, type FormEvent } from 'react';
import {
  validateWaveToken,
  saveWaveConnection,
  saveWaveAccounts,
  getWaveAccounts,
  getWaveTaxes,
  type Settings as SettingsData,
} from '../shared/api';
import { useToast } from '../shared/Toast';

interface Props {
  settings: SettingsData | null;
  waveHealthy: boolean | null;
  onSaved: () => void;
}

interface WaveBusiness {
  id: string;
  name: string;
  isPersonal: boolean;
}

interface WaveAccount {
  id: string;
  name: string;
}

interface WaveTax {
  id: string;
  name: string;
  rate: number;
}

type Stage = 'idle' | 'token' | 'business' | 'accounts';

/**
 * Wave Accounting panel for the Settings page.
 *
 * Runs the same token → business → accounts flow as the onboarding
 * wizard, so a user who skipped that step can connect Wave later without
 * hand-editing `.env`.
 */
export function WaveSettings({ settings, waveHealthy, onSaved }: Props) {
  const [stage, setStage] = useState<Stage>('idle');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [businesses, setBusinesses] = useState<WaveBusiness[]>([]);
  const [expenseAccounts, setExpenseAccounts] = useState<WaveAccount[]>([]);
  const [anchorAccounts, setAnchorAccounts] = useState<WaveAccount[]>([]);
  const [taxes, setTaxes] = useState<WaveTax[]>([]);
  const [expenseAccountId, setExpenseAccountId] = useState('');
  const [anchorAccountId, setAnchorAccountId] = useState('');
  const [salesTaxId, setSalesTaxId] = useState('');
  const { showToast } = useToast();

  const reset = () => {
    setStage('idle');
    setToken('');
    setError('');
    setBusinesses([]);
    setExpenseAccounts([]);
    setAnchorAccounts([]);
    setTaxes([]);
    setExpenseAccountId('');
    setAnchorAccountId('');
    setSalesTaxId('');
  };

  const handleTokenSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!token.trim()) return;

    setBusy(true);
    try {
      const result = await validateWaveToken(token.trim());
      if (!result.valid) {
        setError(result.error || 'That token could not be validated.');
        return;
      }
      setBusinesses(result.businesses || []);
      setStage('business');
    } catch (err) {
      setError((err as Error).message || 'Could not validate the token.');
    } finally {
      setBusy(false);
    }
  };

  const handleSelectBusiness = async (business: WaveBusiness) => {
    setError('');
    setBusy(true);
    try {
      await saveWaveConnection({
        token: token.trim(),
        businessId: business.id,
        businessName: business.name,
      });
      const [accounts, taxList] = await Promise.all([getWaveAccounts(), getWaveTaxes()]);
      setExpenseAccounts(accounts.expense);
      setAnchorAccounts(accounts.anchor);
      setTaxes(taxList);
      if (accounts.expense.length === 1) setExpenseAccountId(accounts.expense[0].id);
      if (accounts.anchor.length === 1) setAnchorAccountId(accounts.anchor[0].id);
      setStage('accounts');
    } catch (err) {
      setError((err as Error).message || 'Could not load accounts for that business.');
    } finally {
      setBusy(false);
    }
  };

  const handleAccountsSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!expenseAccountId || !anchorAccountId) {
      setError('Choose an expense account and an anchor account.');
      return;
    }

    setBusy(true);
    try {
      await saveWaveAccounts({ expenseAccountId, anchorAccountId, salesTaxId });
      showToast('Wave connected.', 'success');
      reset();
      onSaved();
    } catch (err) {
      setError((err as Error).message || 'Could not save Wave settings.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="settings-section">
      <h2 className="settings-section-title">Wave Accounting</h2>
      <div className="settings-row">
        <span className="settings-label">Access Token</span>
        <span className="settings-value">
          {settings?.hasWaveToken ? (
            <span className="settings-key-preview">{settings.waveTokenPreview}</span>
          ) : (
            <span className="settings-not-set">Not configured</span>
          )}
        </span>
      </div>
      <div className="settings-row">
        <span className="settings-label">Connection</span>
        <span className="settings-value">
          {waveHealthy === null ? (
            '…'
          ) : waveHealthy ? (
            <span className="settings-healthy">Connected</span>
          ) : (
            <span className="settings-unhealthy">Disconnected</span>
          )}
        </span>
      </div>
      {settings?.waveBusinessName && (
        <div className="settings-row">
          <span className="settings-label">Business</span>
          <span className="settings-value">{settings.waveBusinessName}</span>
        </div>
      )}

      {stage === 'idle' && (
        <button className="link-button" onClick={() => setStage('token')}>
          {settings?.hasWaveToken ? 'Reconnect Wave' : 'Connect Wave'}
        </button>
      )}

      {stage === 'token' && (
        <form onSubmit={handleTokenSubmit}>
          <label className="wizard-field-label" htmlFor="wave-token">
            Access token
          </label>
          <input
            id="wave-token"
            className="auth-input"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Wave access token"
            autoComplete="off"
            autoFocus
          />
          <p className="settings-help">
            Create a full-access token at <code>developer.waveapps.com</code> under Manage Applications.
            Used to upload approved receipts as expenses.
          </p>
          {error && <p className="auth-error">{error}</p>}
          <div className="request-actions">
            <button type="submit" className="btn-primary" disabled={busy || !token.trim()}>
              {busy ? 'Connecting…' : 'Connect'}
            </button>
            <button type="button" className="btn-secondary" onClick={reset} disabled={busy}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {stage === 'business' && (
        <>
          <p className="settings-help">Which Wave business should receipts upload to?</p>
          {error && <p className="auth-error">{error}</p>}
          <div className="wizard-list">
            {businesses.map((b) => (
              <button
                key={b.id}
                className="wizard-list-item"
                onClick={() => handleSelectBusiness(b)}
                disabled={busy}
              >
                <span>{b.name}</span>
                {b.isPersonal && <span className="settings-not-set">Personal</span>}
              </button>
            ))}
          </div>
          <button className="wizard-back" onClick={() => setStage('token')} disabled={busy}>
            ← Back
          </button>
        </>
      )}

      {stage === 'accounts' && (
        <form onSubmit={handleAccountsSubmit}>
          <label className="wizard-field-label" htmlFor="wave-expense-account">
            Expense account
          </label>
          <select
            id="wave-expense-account"
            className="wizard-select"
            value={expenseAccountId}
            onChange={(e) => setExpenseAccountId(e.target.value)}
          >
            <option value="">Select…</option>
            {expenseAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>

          <label className="wizard-field-label" htmlFor="wave-anchor-account">
            Paid from
          </label>
          <select
            id="wave-anchor-account"
            className="wizard-select"
            value={anchorAccountId}
            onChange={(e) => setAnchorAccountId(e.target.value)}
          >
            <option value="">Select…</option>
            {anchorAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>

          <label className="wizard-field-label" htmlFor="wave-sales-tax">
            Sales tax (optional)
          </label>
          <select
            id="wave-sales-tax"
            className="wizard-select"
            value={salesTaxId}
            onChange={(e) => setSalesTaxId(e.target.value)}
          >
            <option value="">None</option>
            {taxes.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({(t.rate * 100).toFixed(1)}%)
              </option>
            ))}
          </select>

          {error && <p className="auth-error">{error}</p>}
          <div className="request-actions">
            <button
              type="submit"
              className="btn-primary"
              disabled={busy || !expenseAccountId || !anchorAccountId}
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setStage('business')}
              disabled={busy}
            >
              ← Back
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
