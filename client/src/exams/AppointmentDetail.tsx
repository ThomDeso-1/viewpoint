import { useState } from 'react';
import { Link } from 'react-router-dom';
import {
  cancelAppointment,
  checkAppointmentEligibility,
  deleteAppointment,
  linkPatientToAppointment,
  type Appointment,
  type Patient,
} from '../shared/api';
import { useToast } from '../shared/Toast';

interface Props {
  appointment: Appointment;
  patients: Patient[];
  ohipEnabled: boolean;
  /** Open the edit form for this appointment. */
  onEdit: () => void;
  /** Something changed server-side — the Schedule should refetch. */
  onChanged: () => void;
  onClose: () => void;
}

/**
 * The panel shown below the calendar when an event is selected: what the
 * appointment is, its coverage, and the actions that reach Outlook —
 * edit, cancel (tombstone), open in Outlook, and the buried hard delete.
 *
 * A recurring event is read-only here: it can only be changed in Outlook.
 */
export function AppointmentDetail({ appointment, patients, ohipEnabled, onEdit, onChanged, onClose }: Props) {
  const [busy, setBusy] = useState<'cancel' | 'delete' | 'check' | null>(null);
  const { showToast } = useToast();

  const run = async (kind: NonNullable<typeof busy>, fn: () => Promise<unknown>, ok: string) => {
    setBusy(kind);
    try {
      await fn();
      if (ok) showToast(ok, 'success');
      onChanged();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const handleLink = async (patientId: string) => {
    if (!patientId) return;
    await run('check', () => linkPatientToAppointment(appointment.id, patientId), 'Patient linked.');
  };

  const handleCheck = async () => {
    setBusy('check');
    try {
      const result = await checkAppointmentEligibility(appointment.id);
      const suffix = result.reused ? ' (from a recent check)' : '';
      showToast(
        result.error
          ? `Check failed: ${result.error}`
          : result.isEligible
            ? `Coverage confirmed.${suffix}`
            : `Not covered: ${result.responseDescription ?? result.responseCode}${suffix}`,
        result.error || !result.isEligible ? 'error' : 'success',
      );
      onChanged();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const handleCancel = () => {
    const who = appointment.patient?.full_name ?? appointment.title ?? 'this appointment';
    if (!window.confirm(`Cancel ${who}? Outlook will show it as cancelled.`)) return;
    run('cancel', () => cancelAppointment(appointment.id), 'Appointment cancelled.');
  };

  const handleDelete = () => {
    if (
      !window.confirm(
        'Delete this appointment permanently? It is removed from Outlook too (recoverable from Deleted Items). Use Cancel instead for a normal cancellation.',
      )
    )
      return;
    run('delete', () => deleteAppointment(appointment.id).then(onClose), 'Appointment deleted.');
  };

  const cancelled = appointment.status === 'cancelled';
  const recurring = appointment.is_recurring === 1;

  return (
    <section className="card appointment-detail">
      <div className="appointment-detail-head">
        <h2>
          {appointment.patient ? (
            <Link to={`/patients/${appointment.patient.id}`}>{appointment.patient.full_name}</Link>
          ) : (
            (appointment.title ?? 'Untitled appointment')
          )}
        </h2>
        <button className="link-button" onClick={onClose} aria-label="Close">
          Close
        </button>
      </div>

      <p className="muted">{formatRange(appointment.starts_at, appointment.ends_at)}</p>

      <div className="appointment-detail-badges">
        {cancelled && <span className="tag tag-mock">Cancelled</span>}
        {recurring && <span className="tag">Recurring</span>}
        {appointment.sync_state !== 'synced' && (
          <span className="tag tag-warn" title="Not yet saved to Outlook — will retry">
            Not synced
          </span>
        )}
      </div>

      {!appointment.patient && !recurring && (
        <label className="wizard-field-label">
          Link a patient
          <select
            className="wizard-select"
            aria-label="Link a patient"
            defaultValue=""
            disabled={busy !== null}
            onChange={(e) => handleLink(e.target.value)}
          >
            <option value="">Choose a patient…</option>
            {patients.map((p) => (
              <option key={p.id} value={p.id}>
                {p.full_name}
              </option>
            ))}
          </select>
        </label>
      )}

      {ohipEnabled && appointment.patient && (
        <div className="appointment-detail-ohip">
          <EligibilityTag appointment={appointment} />
          <button className="secondary" onClick={handleCheck} disabled={busy === 'check'}>
            {busy === 'check' ? 'Checking…' : 'Check OHIP'}
          </button>
        </div>
      )}

      <div className="appointment-actions">
        {recurring ? (
          <span className="muted">Recurring — edit in Outlook</span>
        ) : (
          <>
            {!cancelled && (
              <button className="link-button" onClick={onEdit}>
                Edit
              </button>
            )}
            {!cancelled && (
              <button className="link-button" onClick={handleCancel} disabled={busy === 'cancel'}>
                {busy === 'cancel' ? 'Cancelling…' : 'Cancel appointment'}
              </button>
            )}
          </>
        )}
        {appointment.web_link && (
          <a className="link-button" href={appointment.web_link} target="_blank" rel="noreferrer">
            Open in Outlook
          </a>
        )}
        {!recurring && (
          <button className="link-button link-danger" onClick={handleDelete} disabled={busy === 'delete'}>
            {busy === 'delete' ? 'Deleting…' : 'Delete permanently'}
          </button>
        )}
      </div>
    </section>
  );
}

export function EligibilityTag({ appointment }: { appointment: Appointment }) {
  const check = appointment.eligibility;

  if (!check) return <span className="muted">OHIP not checked</span>;
  if (check.error) return <span className="eligibility eligibility-unknown">Check failed</span>;

  return (
    <span className={`eligibility ${check.is_eligible ? 'eligibility-ok' : 'eligibility-bad'}`}>
      {check.is_eligible ? 'OHIP covered' : `Not covered (${check.response_code})`}
      {check.mode === 'mock' && <span className="tag tag-mock">mock</span>}
    </span>
  );
}

function formatRange(startsAt: string, endsAt: string | null): string {
  const start = new Date(startsAt);
  if (Number.isNaN(start.getTime())) return '—';
  const date = start.toLocaleDateString('en-CA', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  const t = (d: Date) => d.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' });
  const end = endsAt ? new Date(endsAt) : null;
  return end && !Number.isNaN(end.getTime())
    ? `${date} · ${t(start)} – ${t(end)}`
    : `${date} · ${t(start)}`;
}
