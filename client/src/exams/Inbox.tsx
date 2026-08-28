import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getExamRequests,
  getExamRequestCounts,
  getExamRequestSource,
  pollExamRequests,
  approveExamRequest,
  rejectExamRequest,
  retryExamRequest,
  type ExamRequest,
  type ExamRequestCounts,
} from '../shared/api';
import { useToast } from '../shared/Toast';
import { StatusBadge } from '../shared/StatusBadge';
import { InvoiceEditor } from '../exams/InvoiceEditor';

/**
 * The exam-request inbox.
 *
 * Each card is a fully drafted package — patient, appointment,
 * eligibility, invoice, reminder — that the operator commits with one
 * tap. Nothing on this screen has been sent yet; Approve is the moment
 * anything reaches a patient or the books.
 */
export function Inbox() {
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

  const handlePoll = async () => {
    setPolling(true);
    try {
      const { created } = await pollExamRequests();
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
    <div className="page">
      <header className="page-header">
        <h1>Exam requests</h1>
        <div className="header-actions">
          <button onClick={handlePoll} disabled={polling} className="secondary">
            {polling ? 'Checking…' : 'Check email'}
          </button>
          <Link to="/" className="button-link">
            Receipts
          </Link>
        </div>
      </header>

      {meta && !meta.gmailQueryConfigured && (
        <div className="banner banner-warning">
          No Gmail search is configured yet, so nothing will arrive automatically.{' '}
          <Link to="/settings">Set one up in Settings.</Link>
        </div>
      )}

      {meta && meta.hcvMode === 'mock' && (
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
  );
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
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

function ExamRequestCard({
  request,
  busy,
  onApprove,
  onReject,
  onRetry,
  onInvoiceSaved,
}: {
  request: ExamRequest;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  onRetry: () => void;
  onInvoiceSaved: () => void;
}) {
  const [showEmail, setShowEmail] = useState(false);
  const [emailBody, setEmailBody] = useState<string | null>(null);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [showReminder, setShowReminder] = useState(false);

  // The email body is PHI and access is audited, so it is fetched only
  // when the operator opens it — not delivered with the card.
  async function toggleEmail() {
    const next = !showEmail;
    setShowEmail(next);
    if (next && emailBody === null && emailError === null) {
      try {
        const { body } = await getExamRequestSource(request.id);
        setEmailBody(body ?? '');
      } catch (err) {
        setEmailError((err as Error).message);
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
            {request.from_address} · received {formatDateTime(request.received_at)}
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
          <dt>OHIP</dt>
          <dd>
            <EligibilityLine request={request} />
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
        <button className="link-button" onClick={toggleEmail}>
          {showEmail ? 'Hide original email' : 'Show original email'}
        </button>
      )}
      {showEmail && (
        <pre className="preview-block">
          {emailError
            ? `Could not load the email: ${emailError}`
            : emailBody === null
              ? 'Loading…'
              : emailBody}
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
