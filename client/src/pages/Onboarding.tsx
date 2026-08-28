import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  validateClaudeKey,
  saveClaudeKey,
  validateWaveToken,
  saveWaveConnection,
  saveWaveAccounts,
  getWaveAccounts,
  getWaveTaxes,
  markOnboarded,
  saveOhipSettings,
} from '../api/client';

interface Props {
  onComplete: () => void;
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

type OuterStep = 'claude' | 'wave' | 'ohip';
type WaveStage = 'token' | 'business' | 'accounts';

export function Onboarding({ onComplete }: Props) {
  const navigate = useNavigate();
  const [step, setStep] = useState<OuterStep>('claude');

  // ── Claude API key ──
  const [claudeKey, setClaudeKey] = useState('');
  const [claudeError, setClaudeError] = useState('');
  const [claudeSubmitting, setClaudeSubmitting] = useState(false);

  // ── Wave connection ──
  const [waveStage, setWaveStage] = useState<WaveStage>('token');
  const [waveToken, setWaveToken] = useState('');
  const [waveError, setWaveError] = useState('');
  const [waveSubmitting, setWaveSubmitting] = useState(false);
  const [businesses, setBusinesses] = useState<WaveBusiness[]>([]);
  const [expenseAccounts, setExpenseAccounts] = useState<WaveAccount[]>([]);
  const [anchorAccounts, setAnchorAccounts] = useState<WaveAccount[]>([]);
  const [taxes, setTaxes] = useState<WaveTax[]>([]);
  const [expenseAccountId, setExpenseAccountId] = useState('');
  const [anchorAccountId, setAnchorAccountId] = useState('');
  const [salesTaxId, setSalesTaxId] = useState('');

  // ── OHIP ──
  const [ohipMode, setOhipMode] = useState<'mock' | 'conformance' | 'production'>('mock');
  const [ohipPrivateKeyPath, setOhipPrivateKeyPath] = useState('');
  const [ohipCertificatePath, setOhipCertificatePath] = useState('');
  const [ohipUsername, setOhipUsername] = useState('');
  const [ohipPassword, setOhipPassword] = useState('');
  const [ohipMohId, setOhipMohId] = useState('');
  const [ohipKey, setOhipKey] = useState('');
  const [ohipError, setOhipError] = useState('');
  const [ohipSubmitting, setOhipSubmitting] = useState(false);

  const finish = async () => {
    await markOnboarded();
    onComplete();
    navigate('/', { replace: true });
  };

  const handleOhipSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setOhipError('');
    setOhipSubmitting(true);

    try {
      if (ohipMode === 'mock') {
        await saveOhipSettings({ mode: 'mock' });
      } else {
        if (!ohipPrivateKeyPath.trim() || !ohipCertificatePath.trim()) {
          setOhipError('A private key and certificate are both required for real validation.');
          return;
        }
        await saveOhipSettings({
          mode: ohipMode,
          privateKeyPath: ohipPrivateKeyPath.trim(),
          certificatePath: ohipCertificatePath.trim(),
          username: ohipUsername.trim(),
          password: ohipPassword,
          mohId: ohipMohId.trim(),
          conformanceKey: ohipKey,
        });
      }
      await finish();
    } catch (err: any) {
      setOhipError(err.message || 'Could not save OHIP settings.');
    } finally {
      setOhipSubmitting(false);
    }
  };

  const handleSkipOhip = async () => {
    setOhipSubmitting(true);
    try {
      // Explicitly mock rather than unset, so eligibility results are
      // always labelled as simulated instead of silently absent.
      await saveOhipSettings({ mode: 'mock' });
      await finish();
    } catch {
      await finish();
    } finally {
      setOhipSubmitting(false);
    }
  };

  // ── Claude step handlers ──

  const handleClaudeSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setClaudeError('');

    if (!claudeKey.trim()) return;

    setClaudeSubmitting(true);
    try {
      const result = await validateClaudeKey(claudeKey.trim());
      if (!result.valid) {
        setClaudeError(result.error || 'That key could not be validated.');
        return;
      }
      await saveClaudeKey(claudeKey.trim());
      setStep('wave');
    } catch (err: any) {
      setClaudeError(err.message || 'Could not validate the key.');
    } finally {
      setClaudeSubmitting(false);
    }
  };

  // ── Wave step handlers ──

  const handleWaveTokenSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setWaveError('');

    if (!waveToken.trim()) return;

    setWaveSubmitting(true);
    try {
      const result = await validateWaveToken(waveToken.trim());
      if (!result.valid) {
        setWaveError(result.error || 'That token could not be validated.');
        return;
      }
      setBusinesses(result.businesses || []);
      setWaveStage('business');
    } catch (err: any) {
      setWaveError(err.message || 'Could not validate the token.');
    } finally {
      setWaveSubmitting(false);
    }
  };

  const handleSelectBusiness = async (business: WaveBusiness) => {
    setWaveError('');
    setWaveSubmitting(true);
    try {
      await saveWaveConnection({
        token: waveToken.trim(),
        businessId: business.id,
        businessName: business.name,
      });
      const [accounts, taxList] = await Promise.all([getWaveAccounts(), getWaveTaxes()]);
      setExpenseAccounts(accounts.expense);
      setAnchorAccounts(accounts.anchor);
      setTaxes(taxList);
      if (accounts.expense.length === 1) setExpenseAccountId(accounts.expense[0].id);
      if (accounts.anchor.length === 1) setAnchorAccountId(accounts.anchor[0].id);
      setWaveStage('accounts');
    } catch (err: any) {
      setWaveError(err.message || 'Could not load accounts for that business.');
    } finally {
      setWaveSubmitting(false);
    }
  };

  const handleAccountsSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setWaveError('');

    if (!expenseAccountId || !anchorAccountId) {
      setWaveError('Choose an expense account and an anchor account.');
      return;
    }

    setWaveSubmitting(true);
    try {
      await saveWaveAccounts({ expenseAccountId, anchorAccountId, salesTaxId });
      setStep('ohip');
    } catch (err: any) {
      setWaveError(err.message || 'Could not save Wave settings.');
    } finally {
      setWaveSubmitting(false);
    }
  };

  const handleSkipWave = () => {
    setStep('ohip');
  };

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-logo">
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none">
            <rect width="48" height="48" rx="12" fill="var(--accent)" />
            <path d="M14 34V18L24 12L34 18V34" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M20 34V26H28V34" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="24" cy="21" r="2.5" stroke="white" strokeWidth="2" />
          </svg>
        </div>

        {step === 'claude' && (
          <>
            <p className="wizard-steps">Step 2 of 4</p>
            <h1>Claude API Key</h1>
            <p className="auth-subtitle">
              Used to read vendor, date, and totals off your receipt photos.
            </p>

            <form onSubmit={handleClaudeSubmit}>
              <input
                type="password"
                value={claudeKey}
                onChange={(e) => setClaudeKey(e.target.value)}
                placeholder="sk-ant-…"
                autoFocus
                autoComplete="off"
                className="auth-input"
              />
              {claudeError && <p className="auth-error">{claudeError}</p>}
              <button
                type="submit"
                className="auth-button"
                disabled={claudeSubmitting || !claudeKey.trim()}
              >
                {claudeSubmitting ? 'Validating…' : 'Validate & Continue'}
              </button>
            </form>
            <button
              className="wizard-skip"
              onClick={() => setStep('wave')}
              disabled={claudeSubmitting}
            >
              Skip for now
            </button>
          </>
        )}

        {step === 'wave' && waveStage === 'token' && (
          <>
            <p className="wizard-steps">Step 3 of 4</p>
            <h1>Connect Wave</h1>
            <p className="auth-subtitle">
              Paste your Wave access token to upload approved receipts as expenses.
            </p>

            <form onSubmit={handleWaveTokenSubmit}>
              <input
                type="password"
                value={waveToken}
                onChange={(e) => setWaveToken(e.target.value)}
                placeholder="Wave access token"
                autoFocus
                autoComplete="off"
                className="auth-input"
              />
              {waveError && <p className="auth-error">{waveError}</p>}
              <button
                type="submit"
                className="auth-button"
                disabled={waveSubmitting || !waveToken.trim()}
              >
                {waveSubmitting ? 'Connecting…' : 'Connect'}
              </button>
            </form>
            <button className="wizard-skip" onClick={handleSkipWave} disabled={waveSubmitting}>
              Skip for now
            </button>
          </>
        )}

        {step === 'wave' && waveStage === 'business' && (
          <>
            <p className="wizard-steps">Step 3 of 4</p>
            <h1>Choose a Business</h1>
            <p className="auth-subtitle">Which Wave business should receipts upload to?</p>

            {waveError && <p className="auth-error">{waveError}</p>}
            <div className="wizard-list">
              {businesses.map((b) => (
                <button
                  key={b.id}
                  className="wizard-list-item"
                  onClick={() => handleSelectBusiness(b)}
                  disabled={waveSubmitting}
                >
                  <span>{b.name}</span>
                  {b.isPersonal && <span className="settings-not-set">Personal</span>}
                </button>
              ))}
            </div>
            <button
              className="wizard-back"
              onClick={() => setWaveStage('token')}
              disabled={waveSubmitting}
            >
              ← Back
            </button>
          </>
        )}

        {step === 'wave' && waveStage === 'accounts' && (
          <>
            <p className="wizard-steps">Step 3 of 4</p>
            <h1>Wave Accounts</h1>
            <p className="auth-subtitle">
              Pick where expenses are recorded and which account they're paid from.
            </p>

            <form onSubmit={handleAccountsSubmit}>
              <label className="wizard-field-label" htmlFor="expense-account">
                Expense account
              </label>
              <select
                id="expense-account"
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

              <label className="wizard-field-label" htmlFor="anchor-account">
                Paid from
              </label>
              <select
                id="anchor-account"
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

              <label className="wizard-field-label" htmlFor="sales-tax">
                Sales tax (optional)
              </label>
              <select
                id="sales-tax"
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

              {waveError && <p className="auth-error">{waveError}</p>}
              <button
                type="submit"
                className="auth-button"
                disabled={waveSubmitting || !expenseAccountId || !anchorAccountId}
              >
                {waveSubmitting ? 'Saving…' : 'Continue'}
              </button>
            </form>
            <button
              className="wizard-back"
              onClick={() => setWaveStage('business')}
              disabled={waveSubmitting}
            >
              ← Back
            </button>
          </>
        )}

        {step === 'ohip' && (
          <>
            <p className="wizard-steps">Step 4 of 4</p>
            <h1>OHIP Validation</h1>
            <p className="auth-subtitle">
              Checks a patient's health card coverage automatically when a request comes in.
            </p>

            <form onSubmit={handleOhipSubmit}>
              <label className="wizard-field-label" htmlFor="onboard-ohip-mode">
                Mode
              </label>
              <select
                id="onboard-ohip-mode"
                className="wizard-select"
                value={ohipMode}
                onChange={(e) => setOhipMode(e.target.value as typeof ohipMode)}
              >
                <option value="mock">Simulated — try it out first</option>
                <option value="conformance">Conformance — ministry test environment</option>
                <option value="production">Production — live ministry service</option>
              </select>

              {ohipMode === 'mock' ? (
                <p className="settings-help">
                  Eligibility results are simulated and labelled <strong>mock</strong> everywhere
                  they appear. You can switch this on properly later in Settings.
                </p>
              ) : (
                <>
                  <p className="settings-help">
                    Needs your ministry credentials. Convert your keystore to PEM first:
                    <br />
                    <code>openssl pkcs12 -in yourStore.p12 -nocerts -nodes -out ohip-key.pem</code>
                    <br />
                    <code>openssl pkcs12 -in yourStore.p12 -clcerts -nokeys -out ohip-cert.pem</code>
                  </p>

                  <label className="wizard-field-label">
                    Private key path
                    <input
                      className="auth-input"
                      value={ohipPrivateKeyPath}
                      onChange={(e) => setOhipPrivateKeyPath(e.target.value)}
                      placeholder="/Users/you/ohip/ohip-key.pem"
                    />
                  </label>

                  <label className="wizard-field-label">
                    Certificate path
                    <input
                      className="auth-input"
                      value={ohipCertificatePath}
                      onChange={(e) => setOhipCertificatePath(e.target.value)}
                      placeholder="/Users/you/ohip/ohip-cert.pem"
                    />
                  </label>

                  <label className="wizard-field-label">
                    GO Secure username
                    <input
                      className="auth-input"
                      value={ohipUsername}
                      onChange={(e) => setOhipUsername(e.target.value)}
                      autoComplete="off"
                    />
                  </label>

                  <label className="wizard-field-label">
                    GO Secure password
                    <input
                      className="auth-input"
                      type="password"
                      value={ohipPassword}
                      onChange={(e) => setOhipPassword(e.target.value)}
                      autoComplete="off"
                    />
                  </label>

                  <label className="wizard-field-label">
                    MOH ID / billing number
                    <input
                      className="auth-input"
                      value={ohipMohId}
                      onChange={(e) => setOhipMohId(e.target.value)}
                      autoComplete="off"
                    />
                  </label>

                  <label className="wizard-field-label">
                    {ohipMode === 'production' ? 'Production key' : 'Conformance key'}
                    <input
                      className="auth-input"
                      type="password"
                      value={ohipKey}
                      onChange={(e) => setOhipKey(e.target.value)}
                      autoComplete="off"
                    />
                  </label>
                </>
              )}

              {ohipError && <p className="auth-error">{ohipError}</p>}
              <button type="submit" className="auth-button" disabled={ohipSubmitting}>
                {ohipSubmitting ? 'Finishing…' : 'Finish Setup'}
              </button>
            </form>

            <button className="wizard-skip" onClick={handleSkipOhip} disabled={ohipSubmitting}>
              Skip for now
            </button>
          </>
        )}
      </div>
    </div>
  );
}
