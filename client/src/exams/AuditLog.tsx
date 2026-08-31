import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getAuditLog, verifyAuditChain, type AuditEntry } from '../shared/api';
import { useToast } from '../shared/Toast';

/**
 * The access trail.
 *
 * PHIPA expects a record of who touched personal health information and
 * of anything sent to a patient. This is the read side of that.
 */

const ACTION_LABELS: Record<string, string> = {
  'login.success': 'Signed in',
  'login.failure': 'Failed sign-in',
  logout: 'Signed out',
  'password.set': 'Password changed',
  'patient.read': 'Viewed patient',
  'patient.create': 'Created patient',
  'patient.update': 'Updated patient',
  'patient.delete': 'Deleted patient',
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

/** Entries worth being able to isolate quickly. */
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
  const navigate = useNavigate();
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

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="loading-spinner" />
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Access log</h1>
        <button type="button" className="button-link" onClick={() => navigate(-1)}>
          Back
        </button>
      </header>

      <p className="settings-help">
        Every time patient data is read or changed, and everything sent to a patient. Kept locally,
        newest first. Showing the most recent 500 entries.
      </p>

      {chain && !chain.ok && (
        <div className="banner banner-error">
          The audit log's integrity check failed near entry #{chain.brokenAtId} — a row may have been
          edited or removed outside the app.
        </div>
      )}

      <div className="filter-row">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            className={`filter-chip${filter === f.id ? ' filter-chip-active' : ''}`}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="empty-state">Nothing recorded yet.</p>
      ) : (
        <div className="audit-list">
          {filtered.map((entry) => (
            <div key={entry.id} className="audit-row">
              <span className="audit-time">
                {new Date(entry.at).toLocaleString('en-CA', {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </span>
              <span className="audit-action">{ACTION_LABELS[entry.action] ?? entry.action}</span>
              <span className="muted audit-detail">
                {entry.entity_type && entry.entity_id
                  ? `${entry.entity_type} ${entry.entity_id.slice(0, 8)}`
                  : ''}
                {entry.detail ? ` · ${entry.detail}` : ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
