import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  validateClaudeKey,
  saveClaudeKey,
  validateWaveToken,
  saveWaveConnection,
  markOnboarded,
  saveOhipSettings,
  getMicrosoftStatus,
  type MicrosoftStatus,
} from '../shared/api';

interface Props {
  onComplete: () => void;
  /** When false (the default), the OHIP step is skipped entirely. */
  ohipEnabled?: boolean;
}

interface WaveBusiness {
  id: string;
  name: string;
  isPersonal: boolean;
}

type OuterStep = 'claude' | 'wave' | 'microsoft' | 'ohip';
type WaveStage = 'token' | 'business';

/**
 * First-run wizard. Screens: password (done before this mounts), Claude
 * API key, Wave (token → business), Outlook / Microsoft 365, then OHIP
 * mode.
 *
 * Deliberately short: it only captures what's needed to start working.
 * The finer Wave setup (expense/anchor accounts, sales tax), the full
 * Microsoft app-registration form, and OHIP ministry credentials are done
 * later in Settings, which has the full forms — asking for them here was
 * the biggest drop-off point.
 */
export function Onboarding({ onComplete, ohipEnabled = false }: Props) {
  const navigate = useNavigate();
  const [step, setStep] = useState<OuterStep>('claude');
  const totalSteps = ohipEnabled ? 5 : 4;

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

  // ── Microsoft / Outlook ──
  const [msStatus, setMsStatus] = useState<MicrosoftStatus | null>(null);

  useEffect(() => {
    if (step !== 'microsoft') return;
    let live = true;
    const load = () =>
      Promise.resolve(getMicrosoftStatus())
        .then((s) => {
          if (live) setMsStatus(s ?? null);
        })
        .catch(() => {});
    load();
    // The sign-in link opens in a new tab; catch the operator coming back.
    window.addEventListener('focus', load);
    return () => {
      live = false;
      window.removeEventListener('focus', load);
    };
  }, [step]);

  // ── OHIP ──
  const [ohipError, setOhipError] = useState('');
  const [ohipSubmitting, setOhipSubmitting] = useState(false);

  const finish = async () => {
    await markOnboarded();
    onComplete();
    navigate('/', { replace: true });
  };

  // After Wave: connect Outlook next.
  const afterWave = () => {
    setStep('microsoft');
  };

  // After Microsoft: collect the OHIP mode when the integration is on,
  // otherwise the wizard is done.
  const afterMicrosoft = () => {
    if (ohipEnabled) setStep('ohip');
    else void finish();
  };

  const finishWithMockOhip = async () => {
    setOhipError('');
    setOhipSubmitting(true);
    try {
      // Record "mock" explicitly so eligibility results are labelled
      // simulated rather than silently absent. Real ministry validation is
      // set up later in Settings → OHIP.
      await saveOhipSettings({ mode: 'mock' });
      await finish();
    } catch (err: any) {
      setOhipError(err.message || 'Could not save OHIP settings.');
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
      afterWave();
    } catch (err: any) {
      setWaveError(err.message || 'Could not save that business.');
    } finally {
      setWaveSubmitting(false);
    }
  };

  const handleSkipWave = () => {
    afterWave();
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
            <p className="wizard-steps">Step 2 of {totalSteps}</p>
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
            <p className="wizard-steps">Step 3 of {totalSteps}</p>
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
            <p className="wizard-steps">Step 3 of {totalSteps}</p>
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
            <p className="settings-help">
              You'll pick which accounts expenses post to in Settings, once you're in.
            </p>
            <button
              className="wizard-back"
              onClick={() => setWaveStage('token')}
              disabled={waveSubmitting}
            >
              ← Back
            </button>
          </>
        )}

        {step === 'microsoft' && (
          <>
            <p className="wizard-steps">Step 4 of {totalSteps}</p>
            <h1>Connect Outlook</h1>
            <p className="auth-subtitle">
              Sign in once to send appointment reminders from your mailbox and keep the Schedule in
              sync with your Outlook calendar.
            </p>

            {msStatus?.connected ? (
              <>
                <p className="settings-help">
                  Signed in{msStatus.accountLabel ? ` — ${msStatus.accountLabel}` : ''}.
                </p>
                <button className="auth-button" onClick={afterMicrosoft}>
                  Continue
                </button>
              </>
            ) : (
              <>
                <p className="settings-help">
                  Use a work or school Microsoft 365 account, not a personal outlook.com account —
                  a personal account's sign-in expires every 24 hours instead of every 90 days.
                </p>
                <a
                  className="auth-button"
                  href="/api/microsoft/connect"
                  target="_blank"
                  rel="noopener"
                  style={{ display: 'block', textAlign: 'center' }}
                >
                  Sign in with Microsoft
                </a>
                <p className="muted" style={{ marginTop: 8 }}>
                  Opens in a new tab. Come back here when it's done — this page picks up the change
                  on its own.
                </p>
              </>
            )}

            <button className="wizard-skip" onClick={afterMicrosoft}>
              Skip for now — connect later in Settings
            </button>
          </>
        )}

        {step === 'ohip' && (
          <>
            <p className="wizard-steps">Step 5 of {totalSteps}</p>
            <h1>OHIP Validation</h1>
            <p className="auth-subtitle">
              Checks a patient's health card coverage automatically when a request comes in.
            </p>

            <p className="settings-help">
              This starts in <strong>simulated</strong> mode — results are clearly labelled mock
              everywhere they appear. When you have your ministry certificate, key, and GO Secure
              credentials, switch it on in <strong>Settings → OHIP</strong>, which has the full
              form and a test button.
            </p>

            {ohipError && <p className="auth-error">{ohipError}</p>}
            <button
              className="auth-button"
              onClick={finishWithMockOhip}
              disabled={ohipSubmitting}
            >
              {ohipSubmitting ? 'Finishing…' : 'Finish Setup'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
