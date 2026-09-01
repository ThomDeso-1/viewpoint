import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  getSettings,
  getQueueStatus,
  retryAllFailed,
  getWaveHealth,
  setEmailProvider,
  logout,
  type Settings as SettingsData,
  type QueueStatus,
} from '../shared/api';
import { useToast } from '../shared/Toast';
import { ClaudeSettings } from './ClaudeSettings';
import { WaveSettings } from './WaveSettings';
import { GoogleSettings } from '../exams/GoogleSettings';
import { MicrosoftSettings } from '../exams/MicrosoftSettings';
import { ExamSettings } from '../exams/ExamSettings';
import { OhipSettings } from '../exams/OhipSettings';

export function Settings({ ohipEnabled = false }: { ohipEnabled?: boolean }) {
  const navigate = useNavigate();
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [queue, setQueue] = useState<QueueStatus | null>(null);
  const [waveHealthy, setWaveHealthy] = useState<boolean | null>(null);
  const [retrying, setRetrying] = useState(false);
  const { showToast } = useToast();

  const loadConnections = () => {
    Promise.all([
      getSettings().then(setSettings),
      getWaveHealth().then((h) => setWaveHealthy(h.healthy)),
    ]).catch(() => {});
  };

  useEffect(() => {
    loadConnections();
    getQueueStatus().then(setQueue).catch(() => {});
  }, []);

  const handleRetryAll = async () => {
    setRetrying(true);
    try {
      await retryAllFailed();
      const q = await getQueueStatus();
      setQueue(q);
    } catch (err: any) {
      showToast(err.message || 'Could not retry failed uploads.');
    } finally {
      setRetrying(false);
    }
  };

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  const handleEmailProvider = async (provider: 'google' | 'microsoft') => {
    if (!settings || settings.emailProvider === provider) return;
    try {
      await setEmailProvider(provider);
      await loadConnections();
      showToast(provider === 'microsoft' ? 'Reminders will send from Outlook.' : 'Reminders will send from Gmail.', 'success');
    } catch (err: any) {
      showToast(err.message || 'Could not change the email provider.');
    }
  };

  return (
    <div className="settings-page">
      <header className="review-header">
        <button className="review-back" onClick={() => navigate(-1)}>
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 4l-6 6 6 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <h1 className="review-title">Settings</h1>
        <div style={{ width: 36 }} />
      </header>

      <main className="settings-content">
        <details className="settings-card" open>
          <summary className="settings-card-summary">
            <span className="settings-card-icon" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7">
                <path d="M7 13a3.5 3.5 0 0 1 0-6l2-2a3.5 3.5 0 0 1 5 5l-1 1" strokeLinecap="round" />
                <path d="M13 7a3.5 3.5 0 0 1 0 6l-2 2a3.5 3.5 0 0 1-5-5l1-1" strokeLinecap="round" />
              </svg>
            </span>
            <span className="settings-card-text">
              <span className="settings-card-title">Connections</span>
              <span className="settings-card-desc">Claude, Wave, Google, Outlook, and which mailbox reminders send from</span>
            </span>
            <span className="settings-card-chevron" aria-hidden="true" />
          </summary>

          <ClaudeSettings settings={settings} onSaved={loadConnections} />

          <WaveSettings settings={settings} waveHealthy={waveHealthy} onSaved={loadConnections} />

          <GoogleSettings />
          <MicrosoftSettings />

          {/* Which mailbox reminder emails send from */}
          <section className="settings-section">
            <h2 className="settings-section-title">Reminder email account</h2>
            <p className="settings-help">
              Appointment reminders are sent from this mailbox. Connect the provider above first.
            </p>
            <div className="settings-radio-group">
              <label className="settings-radio">
                <input
                  type="radio"
                  name="email-provider"
                  checked={settings?.emailProvider === 'google'}
                  disabled={!settings}
                  onChange={() => handleEmailProvider('google')}
                />
                <span>
                  Gmail
                  {settings && !settings.googleConnected && (
                    <span className="settings-not-set"> — not connected</span>
                  )}
                </span>
              </label>
              <label className="settings-radio">
                <input
                  type="radio"
                  name="email-provider"
                  checked={settings?.emailProvider === 'microsoft'}
                  disabled={!settings}
                  onChange={() => handleEmailProvider('microsoft')}
                />
                <span>
                  Outlook
                  {settings && !settings.microsoftConnected && (
                    <span className="settings-not-set"> — not connected</span>
                  )}
                </span>
              </label>
            </div>
          </section>
        </details>

        <details className="settings-card">
          <summary className="settings-card-summary">
            <span className="settings-card-icon" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7">
                <path d="M6 2.5h5l3 3v12H6z" strokeLinejoin="round" />
                <path d="M11 2.5v3h3M8 10h4M8 13h4" strokeLinecap="round" />
              </svg>
            </span>
            <span className="settings-card-text">
              <span className="settings-card-title">Exam workflow</span>
              <span className="settings-card-desc">
                Patient files folder, invoicing defaults{ohipEnabled ? ', and OHIP checks' : ''}
              </span>
            </span>
            <span className="settings-card-chevron" aria-hidden="true" />
          </summary>
          <ExamSettings />
          {ohipEnabled && <OhipSettings />}
        </details>

        <details className="settings-card">
          <summary className="settings-card-summary">
            <span className="settings-card-icon" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.7">
                <rect x="3" y="3" width="14" height="14" rx="3" />
                <path d="M7 10l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <span className="settings-card-text">
              <span className="settings-card-title">App &amp; privacy</span>
              <span className="settings-card-desc">Upload queue, access log, and sign out</span>
            </span>
            <span className="settings-card-chevron" aria-hidden="true" />
          </summary>

        {/* Queue */}
        <section className="settings-section">
          <h2 className="settings-section-title">Upload Queue</h2>
          {queue && (
            <div className="settings-queue">
              <div className="settings-row">
                <span className="settings-label">Captured</span>
                <span className="settings-value">{queue.captured}</span>
              </div>
              <div className="settings-row">
                <span className="settings-label">Pending review</span>
                <span className="settings-value">{queue.pending}</span>
              </div>
              <div className="settings-row">
                <span className="settings-label">Failed</span>
                <span className="settings-value">
                  {queue.failed > 0 ? (
                    <span className="settings-unhealthy">{queue.failed}</span>
                  ) : (
                    '0'
                  )}
                </span>
              </div>
              <div className="settings-row">
                <span className="settings-label">Uploaded</span>
                <span className="settings-value">{queue.uploaded}</span>
              </div>
            </div>
          )}
          {queue && queue.failed > 0 && (
            <button
              className="btn-secondary settings-retry-btn"
              onClick={handleRetryAll}
              disabled={retrying}
            >
              {retrying ? 'Retrying…' : 'Retry All Failed'}
            </button>
          )}
        </section>

        {/* Privacy */}
        <section className="settings-section">
          <h2 className="settings-section-title">Privacy</h2>
          <p className="settings-help">
            Every time patient data is read or changed, and everything sent to a patient, is recorded
            locally.
          </p>
          <Link to="/audit" className="btn-secondary">
            View access log
          </Link>
        </section>

        {/* Account */}
        <section className="settings-section">
          <button className="btn-danger" onClick={handleLogout}>
            Sign Out
          </button>
        </section>

        {/* Version */}
        <p className="settings-version">Viewpoint v1.0.0</p>
        </details>
      </main>
    </div>
  );
}
