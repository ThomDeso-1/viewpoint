import { useEffect, useState, useCallback } from 'react';
import {
  listReceipts,
  getQueueStatus,
  deleteReceipt,
  logout,
  type ReceiptGroup,
  type QueueStatus,
} from '../api/client';
import { CaptureButton } from '../components/CaptureButton';
import { ReceiptRow } from '../components/ReceiptRow';
import { UploadStatusBar } from '../components/UploadStatusBar';
import { useNavigate } from 'react-router-dom';

export function ReceiptList() {
  const [groups, setGroups] = useState<ReceiptGroup[]>([]);
  const [queue, setQueue] = useState<QueueStatus | null>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

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

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this receipt?')) return;
    await deleteReceipt(id);
    refresh();
  };

  const handleLogout = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  const handleTap = (id: string) => {
    navigate(`/review/${id}`);
  };

  const totalReceipts = groups.reduce((n, g) => n + g.receipts.length, 0);

  return (
    <div className="receipt-list-page">
      {/* Header */}
      <header className="app-header">
        <h1 className="app-title">Receipts</h1>
        <button className="header-action" onClick={() => navigate('/settings')} title="Settings">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="10" cy="10" r="2.5" />
            <path d="M10 1.5v2M10 16.5v2M3.4 3.4l1.4 1.4M15.2 15.2l1.4 1.4M1.5 10h2M16.5 10h2M3.4 16.6l1.4-1.4M15.2 4.8l1.4-1.4" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      {/* Queue status bar */}
      {queue && <UploadStatusBar queue={queue} />}

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
