import { useEffect, useState, useCallback } from 'react';
import {
  listReceipts,
  getQueueStatus,
  deleteReceipt,
  getHealthStatus,
  getSettings,
  logout,
  type ReceiptGroup,
  type QueueStatus,
  type HealthStatus,
  type Settings,
} from '../shared/api';
import { AddToHomeScreenTip } from '../shared/AddToHomeScreenTip';
import { CaptureButton } from '../receipts/CaptureButton';
import { ReceiptRow } from '../receipts/ReceiptRow';
import { UploadStatusBar } from '../receipts/UploadStatusBar';
import { useToast } from '../shared/Toast';
import { useNavigate } from 'react-router-dom';

export function ReceiptList() {
  const [groups, setGroups] = useState<ReceiptGroup[]>([]);
  const [queue, setQueue] = useState<QueueStatus | null>(null);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const { showToast } = useToast();

  const refresh = useCallback(async () => {
    try {
      const [receipts, status] = await Promise.all([
        listReceipts(search ? { search } : undefined),
        getQueueStatus(),
      ]);
      setGroups(receipts);
      setQueue(status);
    } catch {
      // swallow — will show empty
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    getHealthStatus().then(setHealth).catch(() => {});
    // Demo mode is a property of how the server was started, so it only
    // needs fetching once.
    getSettings().then(setSettings).catch(() => {});
  }, []);

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this receipt?')) return;
    try {
      await deleteReceipt(id);
      refresh();
    } catch (err: any) {
      showToast(err.message || 'Could not delete this receipt.');
    }
  };

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  const handleTap = (id: string) => {
    navigate(`/review/${id}`);
  };

  const totalReceipts = groups.reduce((n, g) => n + g.receipts.length, 0);
  const reviewableCount = groups.reduce(
    (n, g) => n + g.receipts.filter((r) => r.status === 'captured' || r.status === 'extracted').length,
    0,
  );

  return (
    <div className="receipt-list-page">
      {/* Header */}
      <header className="app-header">
        <h1 className="app-title">Receipts</h1>
        <div className="header-actions">
          <button className="header-action" onClick={() => navigate('/inbox')} title="Exam requests">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M2.5 5.5h15v9a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-9Z" strokeLinejoin="round" />
              <path d="m2.5 6 7.5 5 7.5-5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <button className="header-action" onClick={() => navigate('/schedule')} title="Schedule">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
              <rect x="2.5" y="4" width="15" height="13.5" rx="1.5" />
              <path d="M2.5 8h15M6.5 2.5v3M13.5 2.5v3" strokeLinecap="round" />
            </svg>
          </button>
          <button className="header-action" onClick={() => navigate('/settings')} title="Settings">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="10" cy="10" r="2.5" />
              <path d="M10 1.5v2M10 16.5v2M3.4 3.4l1.4 1.4M15.2 15.2l1.4 1.4M1.5 10h2M16.5 10h2M3.4 16.6l1.4-1.4M15.2 4.8l1.4-1.4" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </header>

      <AddToHomeScreenTip />

      {/* Demo mode — must be impossible to mistake for the real thing */}
      {settings?.demoMode && (
        <div className="banner banner-demo">
          <strong>Demo mode.</strong> Claude, Wave, Gmail and Calendar are local fakes — nothing is
          sent to anyone and no invoice is real.{' '}
          <a href="http://localhost:4000" target="_blank" rel="noreferrer">
            See what they captured
          </a>
        </div>
      )}

      {/* Health banners */}
      {health?.claudeConfigured && health.claudeHealthy === false && (
        <div className="banner banner-low health-banner">
          Claude API key is invalid — receipts won't extract automatically. Check Settings.
        </div>
      )}
      {health?.waveConfigured && health.waveHealthy === false && (
        <div className="banner banner-low health-banner">
          Wave connection has expired — uploads are paused. Reconnect in Settings.
        </div>
      )}

      {/* Queue status bar */}
      {queue && <UploadStatusBar queue={queue} />}

      {/* Review all */}
      {reviewableCount > 1 && (
        <div className="health-banner">
          <button className="btn-secondary" style={{ width: '100%' }} onClick={() => navigate('/review-batch')}>
            Review All ({reviewableCount})
          </button>
        </div>
      )}

      {/* Search */}
      <div className="search-bar">
        <svg className="search-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <circle cx="7" cy="7" r="4.5" />
          <path d="M10.5 10.5L14 14" strokeLinecap="round" />
        </svg>
        <input
          type="search"
          placeholder="Search receipts…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="search-input"
        />
      </div>

      {/* Receipt list */}
      <main className="receipt-list">
        {loading ? (
          <div className="empty-state">
            <div className="loading-spinner" />
          </div>
        ) : totalReceipts === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">
              <svg width="48" height="48" viewBox="0 0 48 48" fill="none" stroke="var(--text-tertiary)" strokeWidth="1.5">
                <rect x="10" y="6" width="28" height="36" rx="3" />
                <path d="M18 16h12M18 22h12M18 28h8" strokeLinecap="round" />
              </svg>
            </div>
            <p className="empty-title">No receipts yet</p>
            <p className="empty-subtitle">Tap the camera button to capture your first receipt</p>
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.month} className="month-group">
              <h2 className="month-header">{formatMonth(group.month)}</h2>
              <div className="receipt-cards">
                {group.receipts.map((r) => (
                  <ReceiptRow key={r.id} receipt={r} onTap={() => handleTap(r.id)} onDelete={() => handleDelete(r.id)} />
                ))}
              </div>
            </section>
          ))
        )}
      </main>

      {/* Capture FAB */}
      <CaptureButton onCapture={refresh} />
    </div>
  );
}

function formatMonth(folder: string): string {
  // folder is "YYYY-MM"
  const [year, month] = folder.split('-');
  const date = new Date(parseInt(year), parseInt(month) - 1);
  return date.toLocaleDateString('en-CA', { year: 'numeric', month: 'long' });
}
