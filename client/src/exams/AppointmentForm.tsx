import { useState, type FormEvent } from 'react';
import { createAppointment, updateAppointment, type Appointment, type Patient } from '../shared/api';
import { useToast } from '../shared/Toast';
import { Button } from '../ui/Button';
import { Field, Input, Select } from '../ui/Field';

interface Props {
  patients: Patient[];
  /** Present → edit that appointment; absent → create a new one. */
  appointment?: Appointment;
  /** Create mode only: pre-fill the start (ISO instant, e.g. from a calendar day-click). */
  defaultStartIso?: string;
  onSaved: () => void;
  onCancel: () => void;
}

const DURATIONS = [15, 30, 45, 60];

/** ISO instant → the `YYYY-MM-DDTHH:mm` a datetime-local input wants, in local time. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function initialDuration(appointment?: Appointment): number {
  if (!appointment?.ends_at) return 30;
  const mins = Math.round(
    (new Date(appointment.ends_at).getTime() - new Date(appointment.starts_at).getTime()) / 60_000,
  );
  return mins > 0 ? mins : 30;
}

/**
 * Enters an appointment by hand, or edits an existing one.
 *
 * The Outlook calendar is the source of truth; a create or an edit here
 * pushes straight to it (Phase 2). Recurring events are edited in Outlook
 * only — the Schedule doesn't offer this form for them.
 */
export function AppointmentForm({ patients, appointment, defaultStartIso, onSaved, onCancel }: Props) {
  const editing = !!appointment;
  const [startsAt, setStartsAt] = useState(
    appointment
      ? toLocalInput(appointment.starts_at)
      : defaultStartIso
        ? toLocalInput(defaultStartIso)
        : '',
  );
  const [duration, setDuration] = useState(initialDuration(appointment));
  const [title, setTitle] = useState(appointment?.title ?? '');
  const [location, setLocation] = useState(appointment?.location ?? '');
  const [patientId, setPatientId] = useState(appointment?.patient_id ?? '');
  const [saving, setSaving] = useState(false);
  const { showToast } = useToast();

  const durationOptions = DURATIONS.includes(duration) ? DURATIONS : [duration, ...DURATIONS];

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();

    if (!startsAt) {
      showToast('Choose a date and time.', 'error');
      return;
    }

    setSaving(true);
    try {
      // datetime-local has no zone, so it is read as the business's local
      // time — the same assumption the calendar matcher makes.
      const start = new Date(startsAt);
      const end = new Date(start.getTime() + duration * 60_000);
      const body = {
        startsAt: start.toISOString(),
        endsAt: end.toISOString(),
        title: title.trim() || null,
        location: location.trim() || null,
        patientId: patientId || null,
      };

      if (editing) {
        const result = await updateAppointment(appointment!.id, body);
        showToast(
          result.conflict
            ? 'This appointment changed in Outlook — reloaded the latest version.'
            : 'Appointment updated.',
          result.conflict ? 'error' : 'success',
        );
      } else {
        await createAppointment(body);
        showToast('Appointment added.', 'success');
      }
      onSaved();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="vp-appt-form" onSubmit={handleSubmit}>
      <Field label="Date and time" htmlFor="appt-start">
        <Input
          id="appt-start"
          type="datetime-local"
          value={startsAt}
          onChange={(e) => setStartsAt(e.target.value)}
          required
        />
      </Field>

      <Field label="Length" htmlFor="appt-length">
        <Select id="appt-length" value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
          {durationOptions.map((mins) => (
            <option key={mins} value={mins}>
              {mins === 60 ? '1 hour' : `${mins} minutes`}
            </option>
          ))}
        </Select>
      </Field>

      <Field
        label="Patient"
        htmlFor="appt-patient"
        help="Linking a patient is what allows a reminder for this appointment."
      >
        <Select id="appt-patient" value={patientId} onChange={(e) => setPatientId(e.target.value)}>
          <option value="">Not linked yet</option>
          {patients.map((p) => (
            <option key={p.id} value={p.id}>
              {p.full_name}
            </option>
          ))}
        </Select>
      </Field>

      <Field label="Title" htmlFor="appt-title">
        <Input id="appt-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Eye exam" />
      </Field>

      <Field label="Location" htmlFor="appt-location">
        <Input
          id="appt-location"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="Optional"
        />
      </Field>

      <div className="vp-form-actions">
        <Button type="submit" variant="primary" loading={saving}>
          {editing ? 'Save changes' : 'Add appointment'}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
