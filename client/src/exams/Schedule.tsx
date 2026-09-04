import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getAppointments,
  getCalendarSyncStatus,
  syncCalendarNow,
  cancelAppointment,
  checkAppointmentEligibility,
  getPatients,
  linkPatientToAppointment,
  type Appointment,
  type CalendarSyncStatus,
  type Patient,
} from '../shared/api';
import { useToast } from '../shared/Toast';
import { AppNav } from '../shared/AppNav';
import { AppointmentForm } from '../exams/AppointmentForm';

/**
 * Upcoming appointments, mirrored from the Outlook / Microsoft 365 calendar.
 *
 * When the OHIP integration is on, each linked appointment also shows
 * whether coverage has been confirmed, with a button to re-check on the
 * day. With OHIP off, those surfaces are hidden.
 */
export function Schedule({ ohipEnabled = false }: { ohipEnabled?: boolean }) {
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [patients, setPatients] = useState<Patient[]>([]);
  const [syncStatus, setSyncStatus] = useState<CalendarSyncStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const [linkingId, setLinkingId] = useState<string | null>(null);
  const { showToast } = useToast();

  const load = async () => {
    try {
      const [rows, patientList, sync] = await Promise.all([
        getAppointments(),
        getPatients(),
        getCalendarSyncStatus().catch(() => null),
      ]);
      setAppointments(rows);
      setPatients(patientList);
      setSyncStatus(sync);
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleSyncNow = async () => {
    setSyncing(true);
    try {
      const result = await syncCalendarNow();
      setSyncStatus(result);
      showToast(
        result.pulled > 0 ? `Synced — ${result.pulled} change(s) from Outlook.` : 'Already up to date.',
        'success',
      );
      await load();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setSyncing(false);
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

  const handleCancelAppointment = async (appointment: Appointment) => {
    const who = appointment.patient?.full_name ?? appointment.title ?? 'this appointment';
    if (!window.confirm(`Cancel ${who}? Outlook will show it as cancelled.`)) return;
    setCancellingId(appointment.id);
    try {
      await cancelAppointment(appointment.id);
      showToast('Appointment cancelled.', 'success');
      await load();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setCancellingId(null);
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

      <div className="schedule-sync">
        <span className="muted">
          {syncStatus?.connected ? (
            <>Synced with Outlook · {formatSyncAge(syncStatus.lastSyncedAt)}</>
          ) : (
            <>Not connected to Outlook — sign in from Settings.</>
          )}
        </span>
        {syncStatus?.connected && (
          <button className="link-button" onClick={handleSyncNow} disabled={syncing}>
            {syncing ? 'Syncing…' : 'Sync now'}
          </button>
        )}
      </div>

      {adding && (
        <AppointmentForm
          patients={patients}
          onSaved={() => {
            setAdding(false);
            load();
          }}
          onCancel={() => setAdding(false)}
        />
      )}

      {appointments.length === 0 ? (
        <p className="empty-state">
          No upcoming appointments. These mirror your Outlook calendar — sign in from Settings if you
          haven't yet.
        </p>
      ) : (
        groups.map(([day, items]) => (
          <section key={day} className="schedule-day">
            <h2 className="month-header">{day}</h2>
            {items.map((appointment) =>
              editingId === appointment.id ? (
                <AppointmentForm
                  key={appointment.id}
                  patients={patients}
                  appointment={appointment}
                  onSaved={() => {
                    setEditingId(null);
                    load();
                  }}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <div key={appointment.id} className="appointment-row">
                  <div className="appointment-time">{formatTime(appointment.starts_at)}</div>

                  <div className="appointment-body">
                    <div className="appointment-title">
                      {appointment.patient ? (
                        <Link to={`/patients/${appointment.patient.id}`}>{appointment.patient.full_name}</Link>
                      ) : (
                        (appointment.title ?? 'Untitled appointment')
                      )}
                      {appointment.sync_state !== 'synced' && (
                        <span className="tag tag-warn" title="Not yet saved to Outlook — will retry">
                          Not synced
                        </span>
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

                    <div className="appointment-actions">
                      {appointment.is_recurring ? (
                        <span className="muted">Recurring — edit in Outlook</span>
                      ) : (
                        <>
                          <button className="link-button" onClick={() => setEditingId(appointment.id)}>
                            Edit
                          </button>
                          <button
                            className="link-button"
                            onClick={() => handleCancelAppointment(appointment)}
                            disabled={cancellingId === appointment.id}
                          >
                            {cancellingId === appointment.id ? 'Cancelling…' : 'Cancel'}
                          </button>
                        </>
                      )}
                      {appointment.web_link && (
                        <a className="link-button" href={appointment.web_link} target="_blank" rel="noreferrer">
                          Open in Outlook
                        </a>
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
              ),
            )}
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

/** "updated 3 min ago" / "updated just now" / "never synced". */
function formatSyncAge(iso: string | null): string {
  if (!iso) return 'never synced';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return 'updated just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'updated just now';
  if (minutes < 60) return `updated ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `updated ${hours} h ago`;
  return `updated ${Math.floor(hours / 24)} d ago`;
}
