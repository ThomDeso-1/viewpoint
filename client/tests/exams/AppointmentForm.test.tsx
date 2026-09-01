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
});

function renderForm(onCreated = vi.fn(), onCancel = vi.fn()) {
  render(
    <ToastProvider>
      <AppointmentForm patients={[makePatient()]} onCreated={onCreated} onCancel={onCancel} />
    </ToastProvider>,
  );
  return { onCreated, onCancel };
}

/**
 * Spec: the calendar is normally the source of truth, so this covers what
 * it can't — a walk-in, or a phone booking not yet in Google Calendar.
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
    const { onCreated } = renderForm();

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
    expect(onCreated).toHaveBeenCalled();
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
    const { onCreated } = renderForm();

    await userEvent.type(screen.getByLabelText(/Date and time/i), '2026-09-01T10:00');
    await userEvent.click(screen.getByRole('button', { name: /Add appointment/i }));

    expect(await screen.findByText(/That patient does not exist/i)).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it('cancels without creating anything', async () => {
    const { onCancel } = renderForm();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onCancel).toHaveBeenCalled();
    expect(api.createAppointment).not.toHaveBeenCalled();
  });
});
