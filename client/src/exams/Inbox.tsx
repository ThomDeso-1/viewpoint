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
import { StatusBadge } from '../shared/StatusBadge';
import { formatDateTime, formatMoney } from '../shared/format';
import { InvoiceEditor } from '../exams/InvoiceEditor';
import { Screen } from '../ui/Screen';
import { PageHeader } from '../ui/PageHeader';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { Notice } from '../ui/Notice';
import { EmptyState } from '../ui/EmptyState';
import { SkeletonRows } from '../ui/Skeleton';
import { Dialog } from '../ui/Dialog';
import { Field, Select } from '../ui/Field';
import { KeyValueList, KeyValue } from '../ui/KeyValue';
import { Icon } from '../ui/Icon';

/**
 * The exam-request inbox.
 *
 * Each card is a fully drafted package — patient, appointment,
 * eligibility, invoice, reminder — that the operator commits with one
 * tap. Nothing on this screen has been sent yet; Approve is the moment
 * anything reaches a patient or the books. The card is read-only; every
 * editor lives behind "Review details".
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

  return (
    <Screen width="read">
      <PageHeader
        title="Exam requests"
        actions={
          <Button onClick={handleScan} loading={polling} icon={<Icon name="search" size={15} />}>
            Scan folder
          </Button>
        }
      />

      {meta && !meta.sourceFolderConfigured && (
        <Notice tone="warning" className="vp-mb-4">
          No patient files folder is set yet, so nothing will arrive automatically.{' '}
          <Link to="/settings">Set one up in Settings.</Link>
        </Notice>
      )}

      {meta && meta.filesWithErrors > 0 && (
        <Notice tone="warning" className="vp-mb-4">
          {meta.filesWithErrors} file{meta.filesWithErrors === 1 ? '' : 's'} in the folder could not be
          read. Check the access log for details.
        </Notice>
      )}

      {ohipEnabled && meta && meta.hcvMode === 'mock' && (
        <Notice tone="info" className="vp-mb-4">
          OHIP checks are running against a <strong>mock</strong> service — results are simulated, not
          real coverage. This switches over once ministry conformance testing is complete.
        </Notice>
      )}

      {loading ? (
        <SkeletonRows rows={3} />
      ) : requests.length === 0 ? (
        <EmptyState icon="inbox" title="Nothing waiting">
          New exam requests will appear here automatically.
        </EmptyState>
      ) : (
        <div className="vp-stack">
          {requests.map((req) => (
            <ExamRequestCard
              key={req.id}
              request={req}
              ohipEnabled={ohipEnabled}
              busy={busyId === req.id}
              onApprove={() => handleApprove(req.id)}
              onReject={() => handleReject(req.id)}
              onRetry={() => handleRetry(req.id)}
              onReload={load}
            />
          ))}
        </div>
      )}
    </Screen>
  );
}

function EligibilityLine({ request }: { request: ExamRequest }) {
  const check = request.eligibility;
  if (!check) return <span className="vp-muted">Not checked</span>;
  if (check.error) return <span className="vp-error-text">Check failed — {check.error}</span>;

  const label = check.is_eligible ? 'Covered' : 'Not covered';
  return (
    <span className={check.is_eligible ? 'vp-ok-text' : 'vp-error-text'}>
      {label}
      {check.response_description ? ` — ${check.response_description}` : ''}
      {check.mode === 'mock' && <span className="vp-pill vp-pill--attention vp-pill--dot"> mock</span>}
    </span>
  );
}

/**
 * The schedule file's "Status" column, interpreted. Advisory — it is
 * whatever the clinic wrote in the file, not a live eligibility check.
 */
function CoverageStatusLine({ request }: { request: ExamRequest }) {
  const raw = request.extraction?.coverage_status?.trim();
  if (!raw) return <span className="vp-muted">Not stated on the schedule</span>;

  const prefix =
    request.coverage_class === 'covered'
      ? 'Covered'
      : request.coverage_class === 'not_covered'
        ? 'Not covered'
        : request.coverage_class === 'private_pay'
          ? 'Private pay'
          : null;
  const cls =
    request.coverage_class === 'covered'
      ? 'vp-ok-text'
      : request.coverage_class === 'not_covered'
        ? 'vp-error-text'
        : 'vp-warn-text';

  return (
    <span className={cls}>
      {prefix ? `${prefix} — ` : ''}
      {raw}
      <span className="vp-muted"> (from the schedule)</span>
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

function appointmentText(request: ExamRequest): string {
  if (request.appointment) return formatDateTime(request.appointment.starts_at);
  const ex = request.extraction;
  if (ex?.requested_date) {
    return `Requested ${ex.requested_date}${ex.requested_time ? ` at ${ex.requested_time}` : ''} — no calendar match`;
  }
  return 'Not specified';
}

function contactText(request: ExamRequest): string {
  const email = request.patient?.email ?? request.extraction?.email;
  const phone = request.patient?.phone ?? request.extraction?.phone;
  if (!email && !phone) return '—';
  return [email, phone].filter(Boolean).join(' · ');
}

function ExamRequestCard({
  request,
  ohipEnabled,
  busy,
  onApprove,
  onReject,
  onRetry,
  onReload,
}: {
  request: ExamRequest;
  ohipEnabled: boolean;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  onRetry: () => void;
  onReload: () => void;
}) {
  const [reviewing, setReviewing] = useState(false);

  const patientName =
    request.patient?.full_name ?? request.extraction?.patient_name ?? 'Unidentified patient';
  const canApprove = request.status === 'drafted';
  // "approved" with an error = the Wave commit failed transiently; the queue
  // re-attempts on its own, but offer a manual nudge too.
  const needsAttention =
    request.status === 'needsAttention' ||
    request.status === 'failed' ||
    (request.status === 'approved' && !!request.last_error);

  const invoiceSummary = request.invoice
    ? `${request.invoice.status}${request.invoice.amount != null ? ` · ${formatMoney(request.invoice.amount, request.invoice.currency)}` : ''}`
    : '—';
  const reminderSummary = request.reminder
    ? `${request.reminder.status} · sends ${formatDateTime(request.reminder.scheduled_for)}`
    : '—';

  return (
    <Card as="article" className="vp-exam-card" padded={false}>
      <div className="vp-exam-card-head">
        <div>
          <h2>{patientName}</h2>
          <p className="vp-exam-card-meta">
            {request.source_label ?? 'Imported file'} · added {formatDateTime(request.received_at)}
          </p>
        </div>
        <StatusBadge status={request.status} />
      </div>

      {request.last_error && <Notice tone="danger">{request.last_error}</Notice>}

      <KeyValueList className="vp-exam-card-kv">
        <KeyValue label="Appointment">{appointmentText(request)}</KeyValue>
        <KeyValue label={ohipEnabled ? 'OHIP' : 'Coverage (schedule)'}>
          {ohipEnabled ? <EligibilityLine request={request} /> : <CoverageStatusLine request={request} />}
          {request.extraction?.health_card_masked && (
            <span className="vp-muted"> ({request.extraction.health_card_masked})</span>
          )}
        </KeyValue>
        <KeyValue label="Contact">{contactText(request)}</KeyValue>
        {request.extraction?.notes && (
          <KeyValue label="Notes">
            <span className="vp-prewrap">{request.extraction.notes}</span>
          </KeyValue>
        )}
        <KeyValue label="Invoice">{invoiceSummary}</KeyValue>
        <KeyValue label="Reminder">{reminderSummary}</KeyValue>
      </KeyValueList>

      <div className="vp-exam-card-actions">
        {canApprove && (
          <Button variant="primary" onClick={onApprove} loading={busy}>
            Approve
          </Button>
        )}
        {needsAttention && (
          <Button variant="secondary" onClick={onRetry} disabled={busy}>
            Try again
          </Button>
        )}
        <Button variant="secondary" onClick={onReject} disabled={busy}>
          Dismiss
        </Button>
        {request.patient && (
          <Button variant="ghost" to={`/patients/${request.patient.id}`}>
            Patient record
          </Button>
        )}
        <button type="button" className="vp-exam-card-review" onClick={() => setReviewing(true)}>
          Review details →
        </button>
      </div>

      {reviewing && (
        <ReviewDetailsDialog
          request={request}
          patientName={patientName}
          onClose={() => setReviewing(false)}
          onReload={onReload}
        />
      )}
    </Card>
  );
}

function ReviewDetailsDialog({
  request,
  patientName,
  onClose,
  onReload,
}: {
  request: ExamRequest;
  patientName: string;
  onClose: () => void;
  onReload: () => void;
}) {
  const { showToast } = useToast();
  const [editingInvoice, setEditingInvoice] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [sourceText, setSourceText] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);

  async function changeReminderLead(hours: number) {
    try {
      await updateExamReminder(request.id, hours);
      onReload();
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  }

  // The source record is PHI and access is audited, so it is fetched only
  // when the operator opens it.
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

  const invoice = request.invoice;
  const reminder = request.reminder;

  return (
    <Dialog open onClose={onClose} title="Review details" description={patientName} size="lg">
      <section className="vp-review-section">
        <h3>Invoice</h3>
        {invoice ? (
          <>
            <p>
              {invoice.status}
              {invoice.amount != null && ` · ${formatMoney(invoice.amount, invoice.currency)}`}
              {invoice.last_error && <span className="vp-error-text"> — {invoice.last_error}</span>}
            </p>
            <div className="vp-review-row">
              {invoice.editable &&
                (editingInvoice ? null : (
                  <Button size="sm" variant="secondary" onClick={() => setEditingInvoice(true)}>
                    Edit lines
                  </Button>
                ))}
              {invoice.wave_invoice_url && (
                <Button size="sm" variant="ghost" href={invoice.wave_invoice_url} target="_blank" rel="noreferrer" icon={<Icon name="external" size={13} />}>
                  View in Wave
                </Button>
              )}
            </div>
            {editingInvoice && (
              <InvoiceEditor
                examRequestId={request.id}
                lineItems={invoice.line_items}
                currency={invoice.currency}
                onSaved={() => {
                  setEditingInvoice(false);
                  onReload();
                }}
              />
            )}
          </>
        ) : (
          <p className="vp-muted">No invoice drafted.</p>
        )}
      </section>

      <section className="vp-review-section">
        <h3>Reminder</h3>
        {reminder ? (
          <>
            <p>
              {reminder.status} · sends {formatDateTime(reminder.scheduled_for)}
            </p>
            {reminder.editable && (
              <Field label="Remind" htmlFor="vp-remind-lead" className="vp-mt-4">
                <Select
                  id="vp-remind-lead"
                  value={
                    REMINDER_LEADS.some((l) => l.hours === reminder.lead_hours)
                      ? String(reminder.lead_hours)
                      : ''
                  }
                  onChange={(e) => changeReminderLead(Number(e.target.value))}
                >
                  {!REMINDER_LEADS.some((l) => l.hours === reminder.lead_hours) && (
                    <option value="">
                      {reminder.lead_hours != null ? `${reminder.lead_hours}h before` : 'custom'}
                    </option>
                  )}
                  {REMINDER_LEADS.map((l) => (
                    <option key={l.hours} value={l.hours}>
                      {l.label}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <div className="vp-review-row">
              <Button size="sm" variant="secondary" onClick={() => setShowPreview((v) => !v)}>
                {showPreview ? 'Hide preview' : 'Preview'}
              </Button>
            </div>
            {showPreview && (
              <pre className="vp-preview">
                {`Subject: ${reminder.subject ?? ''}\n\n${reminder.body ?? ''}`}
              </pre>
            )}
          </>
        ) : (
          <p className="vp-muted">No reminder scheduled.</p>
        )}
      </section>

      {request.has_source && (
        <section className="vp-review-section">
          <h3>Source record</h3>
          <div className="vp-review-row">
            <Button size="sm" variant="secondary" onClick={toggleSource}>
              {showSource ? 'Hide source record' : 'Show source record'}
            </Button>
          </div>
          {showSource && (
            <pre className="vp-preview">
              {sourceError
                ? `Could not load the source record: ${sourceError}`
                : sourceText === null
                  ? 'Loading…'
                  : sourceText}
            </pre>
          )}
        </section>
      )}
    </Dialog>
  );
}
