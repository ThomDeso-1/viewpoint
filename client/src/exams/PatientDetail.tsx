import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import {
  getPatient,
  updatePatient,
  checkPatientEligibility,
  type Patient,
  type Appointment,
  type EligibilityCheck,
  type PatientFollowup,
  type FollowupMode,
} from '../shared/api';
import { useToast } from '../shared/Toast';
import { FollowupEmailComposer } from './FollowupEmailComposer';

type PatientDetailData = Patient & {
  appointments: Appointment[];
  eligibility_history: EligibilityCheck[];
  followup: PatientFollowup | null;
};

/** "12 Mar 2026", or null for a missing date. */
function fmtDay(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString('en-CA', { year: 'numeric', month: 'short', day: 'numeric' });
}

const FOLLOWUP_SOURCE_LABEL: Record<NonNullable<PatientFollowup['followup_source']>, string> = {
  booked: 'booked',
  override: 'set by you',
  computed: 'estimated from the last exam',
};

/**
 * One patient's record: contact details, recall, appointment history, and
 * the full eligibility trail.
 *
 * The health card number is only ever shown masked — the server does not
 * return it — so the field here writes a new number rather than editing
 * the existing one.
 */
export function PatientDetail({ ohipEnabled = false }: { ohipEnabled?: boolean }) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { showToast } = useToast();

  const [patient, setPatient] = useState<PatientDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [composingEmail, setComposingEmail] = useState(false);
  const [newHealthCard, setNewHealthCard] = useState('');
  const [form, setForm] = useState({
    full_name: '',
    email: '',
    phone: '',
    health_card_version: '',
    followup_mode: 'remind' as FollowupMode,
    followup_date_override: '',
  });

  const load = async () => {
    if (!id) return;
    try {
      const data = await getPatient(id);
      setPatient(data);
      setForm({
        full_name: data.full_name,
        email: data.email ?? '',
        phone: data.phone ?? '',
        health_card_version: data.health_card_version ?? '',
        followup_mode: data.followup_mode,
        followup_date_override: data.followup_date_override ?? '',
      });
    } catch (err) {
      showToast((err as Error).message, 'error');
      navigate('/inbox');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, [id]);

  const handleSave = async () => {
    if (!id) return;
    setSaving(true);
    try {
      await updatePatient(id, {
        full_name: form.full_name,
        email: form.email || null,
        phone: form.phone || null,
        health_card_version: form.health_card_version || null,
        followup_mode: form.followup_mode,
        followup_date_override: form.followup_date_override || null,
        // Omitted entirely when blank, so saving the form never wipes the
        // card already on file.
        ...(newHealthCard ? { health_card_number: newHealthCard } : {}),
      });
      setNewHealthCard('');
      showToast('Saved.', 'success');
      await load();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleCheck = async () => {
    if (!id) return;
    setChecking(true);
    try {
      const result = await checkPatientEligibility(id);
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
      setChecking(false);
    }
  };

  if (loading || !patient) {
    return (
      <div className="loading-screen">
        <div className="loading-spinner" />
      </div>
    );
  }

  const f = patient.followup;
  const lastExam = fmtDay(f?.last_appointment_at ?? null);
  const upcoming =
    f?.followup_source === 'booked'
      ? { label: 'Current appointment', value: fmtDay(f.current_appointment_at) }
      : f?.followup_date
        ? { label: 'Follow-up', value: fmtDay(f.followup_date) }
        : null;

  return (
    <div className="page">
      <header className="page-header">
        <h1>{patient.full_name}</h1>
        <Link to="/inbox" className="button-link">
          Back
        </Link>
      </header>

      <p className="muted">
        {lastExam ? `Last appointment: ${lastExam}` : 'No past appointments'}
        {upcoming && upcoming.value
          ? ` · ${upcoming.label}: ${upcoming.value}${
              f?.followup_source && f.followup_source !== 'booked'
                ? ` (${FOLLOWUP_SOURCE_LABEL[f.followup_source]})`
                : ''
            }`
          : ''}
        {f?.due ? <span className="tag tag-warn">follow-up due</span> : null}
      </p>

      <section className="card">
        <h2>Details</h2>

        <label>
          Name
          <input
            value={form.full_name}
            onChange={(e) => setForm({ ...form, full_name: e.target.value })}
          />
        </label>

        <label>
          Email
          <input
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
          />
        </label>

        <label>
          Phone
          <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </label>

        <label>
          Health card
          <input
            value={newHealthCard}
            onChange={(e) => setNewHealthCard(e.target.value)}
            placeholder={patient.health_card_masked ?? 'None on file'}
            inputMode="numeric"
          />
          <small className="muted">
            {patient.has_health_card
              ? 'A card is on file. Enter a new number only to replace it.'
              : `No card on file.${ohipEnabled ? ' OHIP checks need one.' : ''}`}
          </small>
        </label>

        <label>
          Version code
          <input
            value={form.health_card_version}
            onChange={(e) => setForm({ ...form, health_card_version: e.target.value.toUpperCase() })}
            maxLength={2}
          />
        </label>

        <div className="followup-block">
          <label>
            Recall
            <select
              value={form.followup_mode}
              onChange={(e) =>
                setForm({ ...form, followup_mode: e.target.value as FollowupMode })
              }
            >
              <option value="off">Off — never remind me</option>
              <option value="remind">Remind me when a follow-up is due</option>
              <option value="followup">Follow up — remind me and offer a recall email</option>
            </select>
          </label>

          <label>
            Follow-up date
            <input
              type="date"
              value={form.followup_date_override}
              onChange={(e) => setForm({ ...form, followup_date_override: e.target.value })}
            />
            <small className="muted">
              {f?.followup_date && f.followup_source !== 'override'
                ? `Leave blank to use the estimated date, ${fmtDay(f.followup_date)}.`
                : 'Leave blank to estimate from the last exam and the patient’s age.'}
            </small>
          </label>
        </div>

        <div className="request-actions">
          <button className="primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          {ohipEnabled && (
            <button
              className="secondary"
              onClick={handleCheck}
              disabled={checking || !patient.has_health_card}
            >
              {checking ? 'Checking…' : 'Check OHIP now'}
            </button>
          )}
        </div>
      </section>

      {f?.due && f.followup_source !== 'booked' && (
        <section className="card">
          <h2>Follow-up due</h2>
          {composingEmail ? (
            <FollowupEmailComposer
              patientId={patient.id}
              onSent={(followup) => {
                setComposingEmail(false);
                setPatient((prev) => (prev ? { ...prev, followup } : prev));
                showToast('Follow-up email sent.', 'success');
              }}
              onCancel={() => setComposingEmail(false)}
            />
          ) : (
            <>
              <p className="muted">
                This patient is due for a follow-up{' '}
                {f.followup_date ? `(${fmtDay(f.followup_date)})` : ''} and has no upcoming
                appointment booked.
                {f.last_emailed_at ? ` Last emailed ${fmtDay(f.last_emailed_at)}.` : ''}
              </p>
              <div className="request-actions">
                <button
                  className="secondary"
                  onClick={() => setComposingEmail(true)}
                  disabled={!patient.email}
                >
                  {patient.email ? 'Draft follow-up email' : 'No email on file'}
                </button>
              </div>
            </>
          )}
        </section>
      )}

      <section className="card">
        <h2>Appointments</h2>
        {patient.appointments.length === 0 ? (
          <p className="muted">None recorded.</p>
        ) : (
          <ul className="plain-list">
            {patient.appointments.map((appointment) => (
              <li key={appointment.id}>
                {new Date(appointment.starts_at).toLocaleString('en-CA')} —{' '}
                {appointment.title ?? 'Exam'}
              </li>
            ))}
          </ul>
        )}
      </section>

      {ohipEnabled && (
        <section className="card">
          <h2>OHIP checks</h2>
          {patient.eligibility_history.length === 0 ? (
            <p className="muted">No checks run yet.</p>
          ) : (
            <ul className="plain-list">
              {patient.eligibility_history.map((check) => (
                <li key={check.id}>
                  <span className="muted">{new Date(check.checked_at).toLocaleString('en-CA')}</span>{' '}
                  {check.error ? (
                    <span className="error-text">failed — {check.error}</span>
                  ) : (
                    <>
                      {check.is_eligible ? 'covered' : 'not covered'}
                      {check.response_code ? ` (${check.response_code})` : ''}
                    </>
                  )}
                  {check.mode === 'mock' && <span className="tag tag-mock">mock</span>}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
