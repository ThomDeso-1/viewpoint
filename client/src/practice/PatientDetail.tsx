import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import {
  getPatient,
  updatePatient,
  checkPatientEligibility,
  type Patient,
  type Appointment,
  type EligibilityCheck,
} from '../shared/api';
import { useToast } from '../shared/Toast';

type PatientDetailData = Patient & {
  appointments: Appointment[];
  eligibility_history: EligibilityCheck[];
};

/**
 * One patient's record: contact details, appointment history, and the
 * full eligibility trail.
 *
 * The health card number is only ever shown masked — the server does not
 * return it — so the field here writes a new number rather than editing
 * the existing one.
 */
export function PatientDetail() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { showToast } = useToast();

  const [patient, setPatient] = useState<PatientDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [newHealthCard, setNewHealthCard] = useState('');
  const [form, setForm] = useState({ full_name: '', email: '', phone: '', health_card_version: '' });

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
      showToast(
        result.error
          ? `Check failed: ${result.error}`
          : result.is_eligible
            ? 'Coverage confirmed.'
            : `Not covered: ${result.response_description ?? result.response_code}`,
        result.error || !result.is_eligible ? 'error' : 'success',
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

  return (
    <div className="page">
      <header className="page-header">
        <h1>{patient.full_name}</h1>
        <Link to="/inbox" className="button-link">
          Back
        </Link>
      </header>

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
              : 'No card on file. OHIP checks need one.'}
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

        <div className="request-actions">
          <button className="primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button className="secondary" onClick={handleCheck} disabled={checking || !patient.has_health_card}>
            {checking ? 'Checking…' : 'Check OHIP now'}
          </button>
        </div>
      </section>

      <section className="card">
        <h2>Appointments</h2>
        {patient.appointments.length === 0 ? (
          <p className="muted">None recorded.</p>
        ) : (
          <ul className="plain-list">
            {patient.appointments.map((appointment) => (
              <li key={appointment.id}>
                {new Date(appointment.starts_at).toLocaleString('en-CA')} — {appointment.title ?? 'Exam'}
              </li>
            ))}
          </ul>
        )}
      </section>

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
    </div>
  );
}
