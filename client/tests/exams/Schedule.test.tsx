import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Schedule } from '../../src/exams/Schedule';
import { ToastProvider } from '../../src/shared/Toast';
import { makeAppointment, makeEligibility, makeEligibilityOutcome, makePatient } from '../helpers/fixtures';

vi.mock('../../src/shared/api');
import * as api from '../../src/shared/api';

beforeEach(() => {
  for (const fn of Object.values(api)) (fn as any).mockReset?.();
  api.getAppointments.mockResolvedValue([]);
  api.getPatients.mockResolvedValue([]);
  api.getCalendarSyncStatus.mockResolvedValue({
    connected: true,
    calendarId: 'primary',
    lastSyncedAt: new Date().toISOString(),
  });
});

function renderSchedule({ ohipEnabled = true }: { ohipEnabled?: boolean } = {}) {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <Schedule ohipEnabled={ohipEnabled} />
      </ToastProvider>
    </MemoryRouter>,
  );
}

/**
 * Spec: the schedule mirrors the Outlook calendar and shows OHIP status
 * per appointment, so the front desk can see coverage at a glance instead
 * of checking each one by hand.
 */
describe('Schedule', () => {
  it('explains the empty state and where appointments come from', async () => {
    renderSchedule();
    expect(await screen.findByText(/mirror your Outlook calendar/i)).toBeInTheDocument();
  });

  it('shows how fresh the Outlook mirror is and syncs on demand', async () => {
    api.syncCalendarNow.mockResolvedValue({
      ok: true,
      connected: true,
      calendarId: 'primary',
      lastSyncedAt: new Date().toISOString(),
      pulled: 2,
    });
    renderSchedule();

    expect(await screen.findByText(/Synced with Outlook/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Sync now/i }));

    await waitFor(() => expect(api.syncCalendarNow).toHaveBeenCalled());
    expect(await screen.findByText(/2 change\(s\) from Outlook/i)).toBeInTheDocument();
  });

  it('points at Settings when Outlook is not connected', async () => {
    api.getCalendarSyncStatus.mockResolvedValue({
      connected: false,
      calendarId: 'primary',
      lastSyncedAt: null,
    });
    renderSchedule();

    expect(await screen.findByText(/Not connected to Outlook/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Sync now/i })).not.toBeInTheDocument();
  });

  it('shows coverage status against an appointment', async () => {
    api.getAppointments.mockResolvedValue([
      { ...makeAppointment(), patient: makePatient(), eligibility: makeEligibility() },
    ]);
    renderSchedule();

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText(/OHIP covered/)).toBeInTheDocument();
  });

  it('labels a simulated result as mock', async () => {
    api.getAppointments.mockResolvedValue([
      { ...makeAppointment(), patient: makePatient(), eligibility: makeEligibility({ mode: 'mock' }) },
    ]);
    renderSchedule();

    expect(await screen.findByText('mock')).toBeInTheDocument();
  });

  it('shows an uncovered patient distinctly', async () => {
    api.getAppointments.mockResolvedValue([
      {
        ...makeAppointment(),
        patient: makePatient(),
        eligibility: makeEligibility({ is_eligible: false, response_code: '52' }),
      },
    ]);
    renderSchedule();

    expect(await screen.findByText(/Not covered \(52\)/)).toBeInTheDocument();
  });

  it('flags an appointment that has never been checked', async () => {
    api.getAppointments.mockResolvedValue([
      { ...makeAppointment(), patient: makePatient(), eligibility: null },
    ]);
    renderSchedule();

    expect(await screen.findByText(/OHIP not checked/i)).toBeInTheDocument();
  });

  it('re-checks coverage on demand', async () => {
    api.getAppointments.mockResolvedValue([
      { ...makeAppointment(), patient: makePatient(), eligibility: null },
    ]);
    api.checkAppointmentEligibility.mockResolvedValue(makeEligibilityOutcome());

    renderSchedule();
    await userEvent.click(await screen.findByRole('button', { name: /Check OHIP/i }));

    await waitFor(() => expect(api.checkAppointmentEligibility).toHaveBeenCalledWith('appt-1'));
    expect(await screen.findByText(/Coverage confirmed/i)).toBeInTheDocument();
  });

  it('hides every OHIP surface when the integration is disabled', async () => {
    api.getAppointments.mockResolvedValue([
      { ...makeAppointment(), patient: makePatient(), eligibility: makeEligibility() },
    ]);
    renderSchedule({ ohipEnabled: false });

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.queryByText(/OHIP covered/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Check OHIP/i })).not.toBeInTheDocument();
  });

  it('offers no check when no patient is linked', async () => {
    api.getAppointments.mockResolvedValue([
      { ...makeAppointment(), patient_id: null, patient: null, eligibility: null },
    ]);
    renderSchedule();

    expect(await screen.findByText(/No patient linked/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Check OHIP/i })).not.toBeInTheDocument();
  });

  describe('linking a patient by hand', () => {
    beforeEach(() => {
      api.getAppointments.mockResolvedValue([
        { ...makeAppointment(), patient_id: null, patient: null, eligibility: null },
      ]);
      api.getPatients.mockResolvedValue([makePatient()]);
      api.linkPatientToAppointment.mockResolvedValue({ success: true });
    });

    it('offers to link when the matcher declined to guess', async () => {
      renderSchedule();
      expect(await screen.findByRole('button', { name: /Link a patient/i })).toBeInTheDocument();
    });

    it('links the chosen patient', async () => {
      renderSchedule();

      await userEvent.click(await screen.findByRole('button', { name: /Link a patient/i }));
      await userEvent.selectOptions(screen.getByLabelText('Link a patient'), 'patient-1');

      await waitFor(() =>
        expect(api.linkPatientToAppointment).toHaveBeenCalledWith('appt-1', 'patient-1'),
      );
      // The row's own "No patient linked" label also matches loosely.
      expect(await screen.findByText('Patient linked.')).toBeInTheDocument();
    });

    it('does nothing if the placeholder option is chosen', async () => {
      renderSchedule();

      await userEvent.click(await screen.findByRole('button', { name: /Link a patient/i }));
      await userEvent.selectOptions(screen.getByLabelText('Link a patient'), '');

      expect(api.linkPatientToAppointment).not.toHaveBeenCalled();
    });
  });

  describe('editing and cancelling from a row', () => {
    it('opens the edit form prefilled for that appointment', async () => {
      api.getAppointments.mockResolvedValue([
        { ...makeAppointment({ title: 'Follow-up' }), patient: null, patient_id: null, eligibility: null },
      ]);
      renderSchedule({ ohipEnabled: false });

      await userEvent.click(await screen.findByRole('button', { name: 'Edit' }));
      expect(screen.getByRole('heading', { name: /Edit appointment/i })).toBeInTheDocument();
      expect(screen.getByLabelText('Title')).toHaveValue('Follow-up');
    });

    it('cancels an appointment after confirmation', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      api.getAppointments.mockResolvedValue([
        { ...makeAppointment(), patient: makePatient(), eligibility: null },
      ]);
      api.cancelAppointment.mockResolvedValue({ appointment: makeAppointment({ status: 'cancelled' }) });
      renderSchedule({ ohipEnabled: false });

      await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

      await waitFor(() => expect(api.cancelAppointment).toHaveBeenCalledWith('appt-1'));
      expect(await screen.findByText('Appointment cancelled.')).toBeInTheDocument();
    });

    it('renders a recurring appointment read-only', async () => {
      api.getAppointments.mockResolvedValue([
        { ...makeAppointment({ is_recurring: 1 }), patient: makePatient(), eligibility: null },
      ]);
      renderSchedule({ ohipEnabled: false });

      expect(await screen.findByText(/Recurring — edit in Outlook/i)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
      expect(screen.getByRole('link', { name: /Open in Outlook/i })).toBeInTheDocument();
    });

    it('flags a row whose push has not landed', async () => {
      api.getAppointments.mockResolvedValue([
        { ...makeAppointment({ sync_state: 'pending_push' }), patient: makePatient(), eligibility: null },
      ]);
      renderSchedule({ ohipEnabled: false });

      expect(await screen.findByText('Not synced')).toBeInTheDocument();
    });
  });

  describe('adding an appointment by hand', () => {
    it('opens and closes the form', async () => {
      renderSchedule();

      await userEvent.click(await screen.findByRole('button', { name: 'Add' }));
      expect(screen.getByText('New appointment')).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: 'Close' }));
      expect(screen.queryByText('New appointment')).not.toBeInTheDocument();
    });

    it('reloads the schedule after one is created', async () => {
      api.createAppointment.mockResolvedValue(makeAppointment());
      renderSchedule();

      await userEvent.click(await screen.findByRole('button', { name: 'Add' }));
      await userEvent.type(screen.getByLabelText(/Date and time/i), '2026-09-01T10:00');
      await userEvent.click(screen.getByRole('button', { name: /Add appointment/i }));

      await waitFor(() => expect(api.createAppointment).toHaveBeenCalled());
      // Initial load plus the reload after creating.
      expect(api.getAppointments.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('groups appointments under a date heading', async () => {
    api.getAppointments.mockResolvedValue([
      { ...makeAppointment({ id: 'a1' }), patient: makePatient(), eligibility: null },
      {
        ...makeAppointment({ id: 'a2', starts_at: '2026-09-01T15:00:00.000Z' }),
        patient: makePatient({ id: 'p2', full_name: 'Bob Jones' }),
        eligibility: null,
      },
    ]);
    renderSchedule();

    await screen.findByText('Ada Lovelace');
    expect(screen.getByText('Bob Jones')).toBeInTheDocument();
    // Both fall on the same day, so there should be exactly one heading.
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(1);
  });
});
