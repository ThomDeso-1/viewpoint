import { useEffect, useMemo, useState } from 'react';
import { getAuditLog, verifyAuditChain, type AuditEntry } from '../shared/api';
import { useToast } from '../shared/Toast';
import { Screen } from '../ui/Screen';
import { PageHeader } from '../ui/PageHeader';
import { Notice } from '../ui/Notice';
import { EmptyState } from '../ui/EmptyState';
import { SkeletonRows } from '../ui/Skeleton';
import { maskId } from '../shared/format';

/**
 * The access trail. PHIPA expects a record of who touched personal health
 * information and of anything sent to a patient. This is the read side.
 */

const ACTION_LABELS: Record<string, string> = {
  'login.success': 'Signed in',
  'login.failure': 'Failed sign-in',
  logout: 'Signed out',
  'password.set': 'Password changed',
  'patient.read': 'Viewed client',
  'patient.create': 'Created client',
  'patient.update': 'Updated client',
  'patient.delete': 'Deleted client',
  'client.import': 'Imported clients from Wave',
  'exam_request.source_read': 'Read source record',
  'file_import.scanned': 'Scanned patient files',
  'file_import.failed': 'File could not be read',
  'health_card.decrypt': 'Read health card',
  'eligibility.check': 'OHIP check',
  'invoice.create': 'Created invoice',
  'invoice.send': 'Sent invoice',
  'reminder.send': 'Sent reminder',
  'oauth.connect': 'Connected account',
  'oauth.disconnect': 'Disconnected account',
};

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'phi', label: 'Patient data', match: (a: string) => a.startsWith('patient.') || a.startsWith('health_card.') },
  { id: 'outbound', label: 'Sent to patients', match: (a: string) => a === 'invoice.send' || a === 'reminder.send' },
  { id: 'auth', label: 'Sign-ins', match: (a: string) => a.startsWith('login.') || a === 'logout' || a === 'password.set' },
];

export function AuditLog() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [filter, setFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [chain, setChain] = useState<{ ok: boolean; brokenAtId: number | null } | null>(null);
  const { showToast } = useToast();

  useEffect(() => {
    getAuditLog(500)
      .then(setEntries)
      .catch((err) => showToast((err as Error).message, 'error'))
      .finally(() => setLoading(false));
    verifyAuditChain().then(setChain).catch(() => setChain(null));
  }, []);

  const filtered = useMemo(() => {
    const active = FILTERS.find((f) => f.id === filter);
    if (!active?.match) return entries;
    return entries.filter((e) => active.match!(e.action));
  }, [entries, filter]);

  return (
    <Screen width="wide" className="vp-audit">
      <PageHeader title="Access log" back />

      <p className="vp-settings-lede">
        Every time patient data is read or changed, and everything sent to a patient. Kept locally,
        newest first — the most recent 500 entries.
      </p>

      {chain && !chain.ok && (
        <Notice tone="danger" className="vp-mt-4">
          The audit log's integrity check failed near entry #{chain.brokenAtId} — a row may have been
          edited or removed outside the app.
        </Notice>
      )}

      <div className="vp-segmented vp-mt-4">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            className={filter === f.id ? 'is-active' : ''}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading ? (
        <SkeletonRows rows={8} />
      ) : filtered.length === 0 ? (
        <EmptyState icon="info" title="Nothing recorded yet" />
      ) : (
        <div className="vp-audit-table-wrap">
          <table className="vp-audit-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Action</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((entry) => (
                <tr key={entry.id}>
                  <td className="vp-audit-time">
                    {new Date(entry.at).toLocaleString('en-CA', {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </td>
                  <td className="vp-audit-action">{ACTION_LABELS[entry.action] ?? entry.action}</td>
                  <td className="vp-audit-detail">
                    {entry.entity_type && entry.entity_id
                      ? `${entry.entity_type} ${maskId(entry.entity_id)}`
                      : ''}
                    {entry.detail ? ` · ${entry.detail}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Screen>
  );
}
