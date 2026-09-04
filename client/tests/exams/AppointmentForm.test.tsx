import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppointmentForm } from '../../src/exams/AppointmentForm';
import { ToastProvider } from '../../src/shared/Toast';
import { makePatient, makeAppointment } from '../helpers/fixtures';

vi.mock('../../src/shared/api');
import * as api from '../../src/shared/api';

beforeEach(() => {
  for (const fn of Object.values(api)) (fn as any).mockReset?.();
  api.createAppointment.mockResolvedValue(makeAppointment());
  api.updateAppointment.mockResolvedValue({ appointment: makeAppointment() });
});

function renderForm(onSaved = vi.fn(), onCancel = vi.fn()) {
  render(
    <ToastProvider>
      <AppointmentForm patients={[makePatient()]} onSaved={onSaved} onCancel={onCancel} />
    </ToastProvider>,
  );
  return { onSaved, onCancel };
}

function renderEditForm(appointment = makeAppointment(), onSaved = vi.fn()) {
  render(
    <ToastProvider>
      <AppointmentForm
        patients={[makePatient()]}
        appointment={appointment}
        onSaved={onSaved}
        onCancel={vi.fn()}
      />
    </ToastProvider>,
  );
  return { onSaved };
}

/**
 * Spec: the calendar is normally the source of truth, so this covers what
 * it can't — a walk-in, or a phone booking not yet in Outlook — plus
 * editing an existing appointment, which pushes the change to Outlook.
 */
describe('AppointmentForm', () => {
  it('offers the known patients, defaulting to unlinked', () => {
    renderForm();

    const select = screen.getByLabelText(/Patient/);
    expect(select).toHaveValue('');
    expect(screen.getByRole('option', { name: 'Ada Lovelace' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Not linked yet' })).toBeInTheDocument();
  });

  it('explains why linking a patient matters', () => {
    renderForm();
    expect(screen.getByText(/allows a reminder for this appointment/i)).toBeInTheDocument();
  });

  it('creates an appointment with a computed end time', async () => {
    const { onSaved } = renderForm();

    await userEvent.type(screen.getByLabelText(/Date and time/i), '2026-09-01T10:00');
    await userEvent.selectOptions(screen.getByLabelText('Length'), '60');
    await userEvent.type(screen.getByLabelText('Title'), 'Walk-in');
    await userEvent.click(screen.getByRole('button', { name: /Add appointment/i }));

    await waitFor(() => expect(api.createAppointment).toHaveBeenCalled());

    const payload = api.createAppointment.mock.calls[0][0];
    // datetime-local carries no zone, so it is read as business-local time.
    expect(payload.startsAt).toBe(new Date('2026-09-01T10:00').toISOString());
    expect(payload.endsAt).toBe(new Date('2026-09-01T11:00').toISOString());
    expect(payload.title).toBe('Walk-in');
    expect(payload.patientId).toBeNull();
    expect(onSaved).toHaveBeenCalled();
  });

  it('links the chosen patient', async () => {
    renderForm();

    await userEvent.type(screen.getByLabelText(/Date and time/i), '2026-09-01T10:00');
    await userEvent.selectOptions(screen.getByLabelText(/Patient/), 'patient-1');
    await userEvent.click(screen.getByRole('button', { name: /Add appointment/i }));

    await waitFor(() => expect(api.createAppointment).toHaveBeenCalled());
    expect(api.createAppointment.mock.calls[0][0].patientId).toBe('patient-1');
  });

  it('surfaces a server rejection', async () => {
    api.createAppointment.mockRejectedValue(new Error('That patient does not exist.'));
    const { onSaved } = renderForm();

    await userEvent.type(screen.getByLabelText(/Date and time/i), '2026-09-01T10:00');
    await userEvent.click(screen.getByRole('button', { name: /Add appointment/i }));

    expect(await screen.findByText(/That patient does not exist/i)).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('cancels without creating anything', async () => {
    const { onCancel } = renderForm();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onCancel).toHaveBeenCalled();
    expect(api.createAppointment).not.toHaveBeenCalled();
  });

  describe('edit mode', () => {
    it('prefills from the appointment and saves via updateAppointment', async () => {
      const appointment = makeAppointment({
        id: 'appt-9',
        title: 'Follow-up',
        starts_at: '2026-09-01T14:00:00.000Z',
        ends_at: '2026-09-01T15:00:00.000Z',
      });
      const { onSaved } = renderEditForm(appointment);

      expect(screen.getByRole('heading', { name: /Edit appointment/i })).toBeInTheDocument();
      expect(screen.getByLabelText('Title')).toHaveValue('Follow-up');

      await userEvent.clear(screen.getByLabelText('Title'));
      await userEvent.type(screen.getByLabelText('Title'), 'Renamed');
      await userEvent.click(screen.getByRole('button', { name: /Save changes/i }));

      await waitFor(() => expect(api.updateAppointment).toHaveBeenCalled());
      const [id, body] = api.updateAppointment.mock.calls[0];
      expect(id).toBe('appt-9');
      expect(body.title).toBe('Renamed');
      expect(onSaved).toHaveBeenCalled();
    });

    it('surfaces an Outlook conflict', async () => {
      api.updateAppointment.mockResolvedValue({ appointment: makeAppointment(), conflict: true });
      renderEditForm();

      await userEvent.click(screen.getByRole('button', { name: /Save changes/i }));

      expect(await screen.findByText(/changed in Outlook/i)).toBeInTheDocument();
    });
  });
});
