import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getAppointments,
  checkAppointmentEligibility,
  getPatients,
  linkPatientToAppointment,
  type Appointment,
  type Patient,
} from '../shared/api';
import { useToast } from '../shared/Toast';
import { AppNav } from '../shared/AppNav';
import { AppointmentForm } from '../exams/AppointmentForm';

/**
 * Upcoming appointments, mirrored from Google Calendar.
 *
 * When the OHIP integration is on, each linked appointment also shows
 * whether coverage has been confirmed, with a button to re-check on the
 * day. With OHIP off, those surfaces are hidden.
 */
export function Schedule({ ohipEnabled = false }: { ohipEnabled?: boolean }) {
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [loading, setLoading] = useState(true);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [linkingId, setLinkingId] = useState<string | null>(null);
  const { showToast } = useToast();

  const load = async () => {
    try {
      const [rows, patientList] = await Promise.all([getAppointments(), getPatients()]);
      setAppointments(rows);
      setPatients(patientList);
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleLink = async (appointmentId: string, patientId: string) => {
    if (!patientId) return;
    try {
      await linkPatientToAppointment(appointmentId, patientId);
      showToast('Patient linked.', 'success');
      setLinkingId(null);
      await load();
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleCheck = async (appointment: Appointment) => {
    setCheckingId(appointment.id);
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
      await load();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setCheckingId(null);
    }
  };

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="loading-spinner" />
      </div>
    );
  }

  const groups = groupByDay(appointments);

  return (
    <>
      <AppNav />
      <div className="page">
      <header className="screen-header">
        <h1 className="screen-title">Schedule</h1>
        <div className="screen-actions">
          <button className="primary" onClick={() => setAdding((v) => !v)}>
            {adding ? 'Close' : 'Add'}
          </button>
        </div>
      </header>

      {adding && (
        <AppointmentForm
          patients={patients}
          onCreated={() => {
            setAdding(false);
            load();
          }}
          onCancel={() => setAdding(false)}
        />
      )}

      {appointments.length === 0 ? (
        <p className="empty-state">
          No upcoming appointments. These mirror your Google Calendar — connect it in Settings if you
          haven't yet.
        </p>
      ) : (
        groups.map(([day, items]) => (
          <section key={day} className="schedule-day">
            <h2 className="month-header">{day}</h2>
            {items.map((appointment) => (
              <div key={appointment.id} className="appointment-row">
                <div className="appointment-time">{formatTime(appointment.starts_at)}</div>

                <div className="appointment-body">
                  <div className="appointment-title">
                    {appointment.patient ? (
                      <Link to={`/patients/${appointment.patient.id}`}>{appointment.patient.full_name}</Link>
                    ) : (
                      (appointment.title ?? 'Untitled appointment')
                    )}
                  </div>

                  <div className="appointment-meta">
                    {appointment.patient ? (
                      ohipEnabled ? (
                        <EligibilityTag appointment={appointment} />
                      ) : null
                    ) : linkingId === appointment.id ? (
                      <select
                        className="wizard-select"
                        aria-label="Link a patient"
                        autoFocus
                        defaultValue=""
                        onChange={(e) => handleLink(appointment.id, e.target.value)}
                      >
                        <option value="">Choose a patient…</option>
                        {patients.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.full_name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <>
                        <span className="muted">No patient linked</span>{' '}
                        <button className="link-button" onClick={() => setLinkingId(appointment.id)}>
                          Link a patient
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {ohipEnabled && appointment.patient && (
                  <button
                    className="secondary"
                    onClick={() => handleCheck(appointment)}
                    disabled={checkingId === appointment.id}
                  >
                    {checkingId === appointment.id ? 'Checking…' : 'Check OHIP'}
                  </button>
                )}
              </div>
            ))}
          </section>
        ))
      )}
      </div>
    </>
  );
}

function EligibilityTag({ appointment }: { appointment: Appointment }) {
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

/** Groups appointments under a date heading, preserving their order. */
function groupByDay(appointments: Appointment[]): [string, Appointment[]][] {
  const groups = new Map<string, Appointment[]>();

  for (const appointment of appointments) {
    const date = new Date(appointment.starts_at);
    const key = Number.isNaN(date.getTime())
      ? 'Unscheduled'
      : date.toLocaleDateString('en-CA', {
          weekday: 'long',
          month: 'long',
          day: 'numeric',
          year: 'numeric',
        });

    const existing = groups.get(key);
    if (existing) existing.push(appointment);
    else groups.set(key, [appointment]);
  }

  return [...groups.entries()];
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleTimeString('en-CA', { hour: 'numeric', minute: '2-digit' });
}
