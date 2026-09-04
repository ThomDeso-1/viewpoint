import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getExamRequests,
  getExamRequestCounts,
  getExamRequestSource,
  scanExamRequests,
  approveExamRequest,
  rejectExamRequest,
  retryExamRequest,
  updateExamReminder,
  type ExamRequest,
  type ExamRequestCounts,
} from '../shared/api';
import { useToast } from '../shared/Toast';
import { AppNav } from '../shared/AppNav';
import { StatusBadge } from '../shared/StatusBadge';
import { parseIsoDate } from '../shared/format';
import { InvoiceEditor } from '../exams/InvoiceEditor';

/**
 * The exam-request inbox.
 *
 * Each card is a fully drafted package — patient, appointment,
 * eligibility, invoice, reminder — that the operator commits with one
 * tap. Nothing on this screen has been sent yet; Approve is the moment
 * anything reaches a patient or the books.
 */
export function Inbox({ ohipEnabled = false }: { ohipEnabled?: boolean }) {
  const [requests, setRequests] = useState<ExamRequest[]>([]);
  const [meta, setMeta] = useState<ExamRequestCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  const { showToast } = useToast();

  const load = async () => {
    try {
      const [rows, counts] = await Promise.all([getExamRequests(), getExamRequestCounts()]);
      setRequests(rows);
      setMeta(counts);
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleScan = async () => {
    setPolling(true);
    try {
      const { created } = await scanExamRequests();
      showToast(
        created > 0 ? `Found ${created} new request${created === 1 ? '' : 's'}.` : 'No new requests.',
        'success',
      );
      await load();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setPolling(false);
    }
  };

  const handleApprove = async (id: string) => {
    setBusyId(id);
    try {
      const result = await approveExamRequest(id);
      if (result.invoice.error) {
        showToast(`Approved, but the invoice failed: ${result.invoice.error}`, 'error');
      } else {
        showToast('Approved — invoice sent and reminder scheduled.', 'success');
      }
      await load();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleReject = async (id: string) => {
    setBusyId(id);
    try {
      await rejectExamRequest(id);
      showToast('Dismissed. Nothing was sent.', 'success');
      await load();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleRetry = async (id: string) => {
    setBusyId(id);
    try {
      await retryExamRequest(id);
      showToast('Queued for another attempt.', 'success');
      await load();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="loading-spinner" />
      </div>
    );
  }

  return (
    <>
      <AppNav />
      <div className="page">
      <header className="screen-header">
        <h1 className="screen-title">Exam requests</h1>
        <div className="screen-actions">
          <button onClick={handleScan} disabled={polling} className="secondary">
            {polling ? 'Scanning…' : 'Scan folder'}
          </button>
        </div>
      </header>

      {meta && !meta.sourceFolderConfigured && (
        <div className="banner banner-warning">
          No patient files folder is set yet, so nothing will arrive automatically.{' '}
          <Link to="/settings">Set one up in Settings.</Link>
        </div>
      )}

      {meta && meta.filesWithErrors > 0 && (
        <div className="banner banner-warning">
          {meta.filesWithErrors} file{meta.filesWithErrors === 1 ? '' : 's'} in the folder could not
          be read. Check the access log for details.
        </div>
      )}

      {ohipEnabled && meta && meta.hcvMode === 'mock' && (
        <div className="banner banner-info">
          OHIP checks are running against a <strong>mock</strong> service — results are simulated, not real
          coverage. This switches over once ministry conformance testing is complete.
        </div>
      )}

      {requests.length === 0 ? (
        <p className="empty-state">Nothing waiting. New exam requests will appear here automatically.</p>
      ) : (
        <div className="request-list">
          {requests.map((req) => (
            <ExamRequestCard
              key={req.id}
              request={req}
              ohipEnabled={ohipEnabled}
              busy={busyId === req.id}
              onApprove={() => handleApprove(req.id)}
              onReject={() => handleReject(req.id)}
              onRetry={() => handleRetry(req.id)}
              onInvoiceSaved={load}
            />
          ))}
        </div>
      )}
      </div>
    </>
  );
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const date = parseIsoDate(iso);
  if (!date) return iso;
  return date.toLocaleString('en-CA', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function EligibilityLine({ request }: { request: ExamRequest }) {
  const check = request.eligibility;

  if (!check) {
    return <span className="muted">Not checked</span>;
  }

  if (check.error) {
    return <span className="eligibility eligibility-unknown">Check failed — {check.error}</span>;
  }

  const label = check.is_eligible ? 'Covered' : 'Not covered';
  const cls = check.is_eligible ? 'eligibility-ok' : 'eligibility-bad';

  return (
    <span className={`eligibility ${cls}`}>
      {label}
      {check.response_description ? ` — ${check.response_description}` : ''}
      {check.mode === 'mock' && <span className="tag tag-mock">mock</span>}
    </span>
  );
}

/**
 * The schedule file's "Status" column, interpreted. This is advisory — it
 * is whatever the clinic wrote in the file, not a live eligibility check —
 * so an unrecognised value shows neutrally with its raw text rather than
 * being forced into a covered/not-covered verdict.
 */
function CoverageStatusLine({ request }: { request: ExamRequest }) {
  const raw = request.extraction?.coverage_status?.trim();
  if (!raw) return <span className="muted">Not stated on the schedule</span>;

  const cls =
    request.coverage_class === 'covered'
      ? 'eligibility-ok'
      : request.coverage_class === 'not_covered'
        ? 'eligibility-bad'
        : 'eligibility-unknown';

  const prefix =
    request.coverage_class === 'covered'
      ? 'Covered'
      : request.coverage_class === 'not_covered'
        ? 'Not covered'
        : request.coverage_class === 'private_pay'
          ? 'Private pay'
          : null;

  return (
    <span className={`eligibility ${cls}`}>
      {prefix ? `${prefix} — ` : ''}
      {raw}
      <span className="muted"> (from the schedule)</span>
    </span>
  );
}

const REMINDER_LEADS = [
  { hours: 24, label: '1 day before' },
  { hours: 48, label: '2 days before' },
  { hours: 72, label: '3 days before' },
  { hours: 168, label: '1 week before' },
  { hours: 336, label: '2 weeks before' },
];

function ExamRequestCard({
  request,
  ohipEnabled,
  busy,
  onApprove,
  onReject,
  onRetry,
  onInvoiceSaved,
}: {
  request: ExamRequest;
  ohipEnabled: boolean;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  onRetry: () => void;
  onInvoiceSaved: () => void;
}) {
  const [showSource, setShowSource] = useState(false);
  const [sourceText, setSourceText] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [showReminder, setShowReminder] = useState(false);
  const { showToast } = useToast();

  async function changeReminderLead(hours: number) {
    try {
      await updateExamReminder(request.id, hours);
      onInvoiceSaved();
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  }

  // The source record is PHI and access is audited, so it is fetched only
  // when the operator opens it — not delivered with the card.
  async function toggleSource() {
    const next = !showSource;
    setShowSource(next);
    if (next && sourceText === null && sourceError === null) {
      try {
        const { body } = await getExamRequestSource(request.id);
        setSourceText(body ?? '');
      } catch (err) {
        setSourceError((err as Error).message);
      }
    }
  }
  const [editingInvoice, setEditingInvoice] = useState(false);

  const extraction = request.extraction;
  const canApprove = request.status === 'drafted';
  // "approved" with an error = the Wave commit failed transiently. The
  // queue re-attempts it on its own, but offer a manual nudge too.
  const needsAttention =
    request.status === 'needsAttention' ||
    request.status === 'failed' ||
    (request.status === 'approved' && !!request.last_error);

  return (
    <article className="request-card">
      <div className="request-card-head">
        <div>
          <h2>{request.patient?.full_name ?? extraction?.patient_name ?? 'Unidentified patient'}</h2>
          <p className="muted">
            {request.source_label ?? 'Imported file'} · added {formatDateTime(request.received_at)}
          </p>
        </div>
        <StatusBadge status={request.status} />
      </div>

      {request.last_error && <div className="banner banner-error">{request.last_error}</div>}

      <dl className="request-details">
        <div>
          <dt>Appointment</dt>
          <dd>
            {request.appointment
              ? formatDateTime(request.appointment.starts_at)
              : extraction?.requested_date
                ? `Requested ${extraction.requested_date}${extraction.requested_time ? ` at ${extraction.requested_time}` : ''} — no calendar match`
                : 'Not specified'}
          </dd>
        </div>

        <div>
          <dt>{ohipEnabled ? 'OHIP' : 'Coverage (schedule)'}</dt>
          <dd>
            {ohipEnabled ? (
              <EligibilityLine request={request} />
            ) : (
              <CoverageStatusLine request={request} />
            )}
            {extraction?.health_card_masked && (
              <span className="muted"> ({extraction.health_card_masked})</span>
            )}
          </dd>
        </div>

        <div>
          <dt>Contact</dt>
          <dd>
            {request.patient?.email ?? extraction?.email ?? '—'}
            {(request.patient?.phone ?? extraction?.phone) && ` · ${request.patient?.phone ?? extraction?.phone}`}
          </dd>
        </div>

        {extraction?.notes && (
          <div>
            <dt>Notes</dt>
            <dd style={{ whiteSpace: 'pre-wrap' }}>{extraction.notes}</dd>
          </div>
        )}

        <div>
          <dt>Invoice</dt>
          <dd>
            {request.invoice ? (
              <>
                {request.invoice.status}
                {request.invoice.amount != null && ` · $${request.invoice.amount.toFixed(2)}`}
                {request.invoice.editable && (
                  <>
                    {' '}
                    <button className="link-button" onClick={() => setEditingInvoice((v) => !v)}>
                      {editingInvoice ? 'Close' : 'Edit lines'}
                    </button>
                  </>
                )}
                {request.invoice.wave_invoice_url && (
                  <>
                    {' '}
                    <a href={request.invoice.wave_invoice_url} target="_blank" rel="noreferrer">
                      View in Wave
                    </a>
                  </>
                )}
                {request.invoice.last_error && (
                  <span className="error-text"> — {request.invoice.last_error}</span>
                )}
              </>
            ) : (
              '—'
            )}
          </dd>
        </div>

        <div>
          <dt>Reminder</dt>
          <dd>
            {request.reminder ? (
              <>
                {request.reminder.status} · sends {formatDateTime(request.reminder.scheduled_for)}{' '}
                <button className="link-button" onClick={() => setShowReminder((v) => !v)}>
                  {showReminder ? 'Hide' : 'Preview'}
                </button>
                {request.reminder.editable && (
                  <>
                    {' · '}
                    <label>
                      Remind:{' '}
                      <select
                        value={
                          REMINDER_LEADS.some((l) => l.hours === request.reminder!.lead_hours)
                            ? String(request.reminder!.lead_hours)
                            : ''
                        }
                        onChange={(e) => changeReminderLead(Number(e.target.value))}
                      >
                        {!REMINDER_LEADS.some((l) => l.hours === request.reminder!.lead_hours) && (
                          <option value="">
                            {request.reminder!.lead_hours != null
                              ? `${request.reminder!.lead_hours}h before`
                              : 'custom'}
                          </option>
                        )}
                        {REMINDER_LEADS.map((l) => (
                          <option key={l.hours} value={l.hours}>
                            {l.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </>
                )}
              </>
            ) : (
              '—'
            )}
          </dd>
        </div>
      </dl>

      {editingInvoice && request.invoice && (
        <InvoiceEditor
          examRequestId={request.id}
          lineItems={request.invoice.line_items}
          currency={request.invoice.currency}
          onSaved={() => {
            setEditingInvoice(false);
            onInvoiceSaved();
          }}
        />
      )}

      {showReminder && request.reminder && (
        <pre className="preview-block">
          {`Subject: ${request.reminder.subject ?? ''}\n\n${request.reminder.body ?? ''}`}
        </pre>
      )}

      {request.has_source && (
        <button className="link-button" onClick={toggleSource}>
          {showSource ? 'Hide source record' : 'Show source record'}
        </button>
      )}
      {showSource && (
        <pre className="preview-block">
          {sourceError
            ? `Could not load the source record: ${sourceError}`
            : sourceText === null
              ? 'Loading…'
              : sourceText}
        </pre>
      )}

      <div className="request-actions">
        {canApprove && (
          <button onClick={onApprove} disabled={busy} className="primary">
            {busy ? 'Working…' : 'Approve'}
          </button>
        )}
        {needsAttention && (
          <button onClick={onRetry} disabled={busy} className="secondary">
            Try again
          </button>
        )}
        <button onClick={onReject} disabled={busy} className="secondary">
          Dismiss
        </button>
        {request.patient && (
          <Link to={`/patients/${request.patient.id}`} className="button-link">
            Patient record
          </Link>
        )}
      </div>
    </article>
  );
}
