import { useEffect, useState, useCallback, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  listReceipts,
  getReceiptSummary,
  deleteReceipt,
  getHealthStatus,
  getSettings,
  type ReceiptGroup,
  type ReceiptSummary,
  type HealthStatus,
  type Settings,
} from '../shared/api';
import { AddToHomeScreenTip } from '../shared/AddToHomeScreenTip';
import { SetupChecklist } from '../receipts/SetupChecklist';
import { CaptureButton } from '../receipts/CaptureButton';
import { ReceiptRow } from '../receipts/ReceiptRow';
import { ReceiptSummaryBar } from '../receipts/ReceiptSummaryBar';
import { needsCheck } from '../receipts/receipt-status';
import { useToast } from '../shared/Toast';
import { Screen } from '../ui/Screen';
import { PageHeader } from '../ui/PageHeader';
import { Button } from '../ui/Button';
import { Notice } from '../ui/Notice';
import { EmptyState } from '../ui/EmptyState';
import { SkeletonRows } from '../ui/Skeleton';
import { ConfirmDialog } from '../ui/Dialog';
import { Icon } from '../ui/Icon';
import { formatMonthFolder } from '../shared/format';

/** How often to refresh while a just-uploaded receipt is still being read. */
export const READING_POLL_MS = 3000;

export function ReceiptList() {
  const [groups, setGroups] = useState<ReceiptGroup[]>([]);
  const [summary, setSummary] = useState<ReceiptSummary | null>(null);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const navigate = useNavigate();
  const { showToast } = useToast();

  const refresh = useCallback(async () => {
    try {
      const [receipts, counts] = await Promise.all([
        listReceipts(search ? { search } : undefined),
        getReceiptSummary(),
      ]);
      setGroups(receipts);
      setSummary(counts);
    } catch {
      // swallow — will show empty
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Uploads are read in the background, so keep refreshing until the
  // fields land. Not while there's no Claude key — they'd never finish.
  const reading = (summary?.processing ?? 0) > 0 && settings?.hasClaudeKey !== false;
  useEffect(() => {
    if (!reading) return;
    const t = setInterval(refresh, READING_POLL_MS);
    return () => clearInterval(t);
  }, [reading, refresh]);

  useEffect(() => {
    getHealthStatus().then(setHealth).catch(() => {});
    getSettings().then(setSettings).catch(() => {});
  }, []);

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await deleteReceipt(pendingDelete);
      setPendingDelete(null);
      refresh();
    } catch (err) {
      showToast((err as Error).message || 'Could not delete this receipt.');
    } finally {
      setDeleting(false);
    }
  };

  const totalReceipts = groups.reduce((n, g) => n + g.receipts.length, 0);
  const toCheckCount = groups.reduce((n, g) => n + g.receipts.filter(needsCheck).length, 0);

  const alerts: ReactNode[] = [];
  if (settings?.demoMode) {
    alerts.push(
      <Notice key="demo" tone="warning">
        <strong>Demo mode.</strong> Claude, Wave and Outlook are local fakes — nothing is sent to
        anyone and no invoice is real.{' '}
        <a href="http://localhost:4000" target="_blank" rel="noreferrer">
          See what they captured
        </a>
      </Notice>,
    );
  }
  if (settings && !settings.hasClaudeKey && (summary?.processing ?? 0) > 0) {
    alerts.push(
      <Notice key="no-claude" tone="warning">
        Add your Claude API key in Settings and new receipts will be read automatically. Until then
        you can fill them in by hand.
      </Notice>,
    );
  }
  if (health?.claudeConfigured && health.claudeHealthy === false) {
    alerts.push(
      <Notice key="claude" tone="danger">
        Claude API key is invalid — receipts won't extract automatically. Check Settings.
      </Notice>,
    );
  }
  if (health?.waveConfigured && health.waveHealthy === false) {
    alerts.push(
      <Notice key="wave" tone="danger">
        Wave connection has expired — exam invoices can't be sent. Reconnect in Settings.
      </Notice>,
    );
  }

  return (
    <Screen width="read" className="vp-receipts">
      <PageHeader
        title="Receipts"
        actions={
          <span className="vp-only-desktop">
            <CaptureButton mode="inline" onCapture={refresh} />
          </span>
        }
      />

      <AddToHomeScreenTip />

      {alerts.length > 0 &&
        (alerts.length <= 2 ? (
          <div className="vp-stack vp-stack--sm vp-mb-4">{alerts}</div>
        ) : (
          <details className="vp-alert-group vp-mb-4">
            <summary>
              {alerts.length} things need your attention
            </summary>
            <div className="vp-stack vp-stack--sm">{alerts}</div>
          </details>
        ))}

      <SetupChecklist settings={settings} />

      {summary && <ReceiptSummaryBar summary={summary} />}

      {toCheckCount > 1 && (
        <Button
          variant="secondary"
          block
          className="vp-mb-4"
          onClick={() => navigate('/review-batch')}
        >
          Check uncertain receipts ({toCheckCount})
        </Button>
      )}

      <div className="vp-search">
        <Icon name="search" size={16} />
        <input
          type="search"
          placeholder="Search receipts…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {loading ? (
        <SkeletonRows rows={4} />
      ) : totalReceipts === 0 ? (
        <EmptyState icon="receipt" title="No receipts yet">
          Capture a photo of a receipt to get started.
        </EmptyState>
      ) : (
        <div className="vp-receipt-months">
          {groups.map((group) => (
            <section key={group.month} className="vp-receipt-month">
              <h2 className="vp-receipt-month-label">{formatMonthFolder(group.month)}</h2>
              <div className="vp-stack vp-stack--sm">
                {group.receipts.map((r) => (
                  <ReceiptRow
                    key={r.id}
                    receipt={r}
                    onTap={() => navigate(`/review/${r.id}`)}
                    onDelete={() => setPendingDelete(r.id)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <span className="vp-only-mobile">
        <CaptureButton onCapture={refresh} />
      </span>

      <ConfirmDialog
        open={pendingDelete != null}
        title="Delete this receipt?"
        message="The photo and its extracted data are removed. This can't be undone."
        confirmLabel="Delete"
        destructive
        loading={deleting}
        onConfirm={confirmDelete}
        onClose={() => setPendingDelete(null)}
      />
    </Screen>
  );
}
