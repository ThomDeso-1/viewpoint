import { useState, type FormEvent } from 'react';
import { createAppointment, type Patient } from '../api/client';
import { useToast } from './Toast';

interface Props {
  patients: Patient[];
  onCreated: () => void;
  onCancel: () => void;
}

/**
 * Enters an appointment by hand.
 *
 * The calendar is normally the source of truth, so this is for the cases
 * it can't cover — a walk-in, or a booking taken by phone that hasn't
 * been put in Google Calendar yet. Such rows are marked `manual` so a
 * later calendar sync won't treat them as stale events.
 */
export function AppointmentForm({ patients, onCreated, onCancel }: Props) {
  const [startsAt, setStartsAt] = useState('');
  const [duration, setDuration] = useState(30);
  const [title, setTitle] = useState('');
  const [location, setLocation] = useState('');
  const [patientId, setPatientId] = useState('');
  const [saving, setSaving] = useState(false);
  const { showToast } = useToast();

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();

    if (!startsAt) {
      showToast('Choose a date and time.', 'error');
      return;
    }

    setSaving(true);
    try {
      // datetime-local has no zone, so it is read as the clinic's local
      // time — the same assumption the calendar matcher makes.
      const start = new Date(startsAt);
      const end = new Date(start.getTime() + duration * 60_000);

      await createAppointment({
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        title: title.trim() || null,
        location: location.trim() || null,
        patientId: patientId || null,
      });

      showToast('Appointment added.', 'success');
      onCreated();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="card" onSubmit={handleSubmit}>
      <h2>New appointment</h2>

      <label>
        Date and time
        <input
          type="datetime-local"
          value={startsAt}
          onChange={(e) => setStartsAt(e.target.value)}
          required
        />
      </label>

      <label>
        Length
        <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
          <option value={15}>15 minutes</option>
          <option value={30}>30 minutes</option>
          <option value={45}>45 minutes</option>
          <option value={60}>1 hour</option>
        </select>
      </label>

      <label>
        Patient
        <select value={patientId} onChange={(e) => setPatientId(e.target.value)}>
          <option value="">Not linked yet</option>
          {patients.map((p) => (
            <option key={p.id} value={p.id}>
              {p.full_name}
            </option>
          ))}
        </select>
        <small className="muted">
          Linking a patient is what allows an OHIP check and a reminder for this appointment.
        </small>
      </label>

      <label>
        Title
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Eye exam" />
      </label>

      <label>
        Location
        <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Optional" />
      </label>

      <div className="request-actions">
        <button type="submit" className="primary" disabled={saving}>
          {saving ? 'Adding…' : 'Add appointment'}
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
