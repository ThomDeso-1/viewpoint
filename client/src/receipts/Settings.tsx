import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  getSettings,
  getQueueStatus,
  retryAllFailed,
  getWaveHealth,
  logout,
  type Settings as SettingsData,
  type QueueStatus,
} from '../shared/api';
import { useToast } from '../shared/Toast';
import { ClaudeSettings } from './ClaudeSettings';
import { WaveSettings } from './WaveSettings';
import { GoogleSettings } from '../exams/GoogleSettings';
import { ExamSettings } from '../exams/ExamSettings';
import { OhipSettings } from '../exams/OhipSettings';

export function Settings() {
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
        <ClaudeSettings settings={settings} onSaved={loadConnections} />

        <WaveSettings settings={settings} waveHealthy={waveHealthy} onSaved={loadConnections} />

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

        <GoogleSettings />
        <ExamSettings />
        <OhipSettings />

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
        <p className="settings-version">Viewpoint Receipts v1.0.0</p>
      </main>
    </div>
  );
}
