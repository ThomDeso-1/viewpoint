import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Schedule } from '../../src/pages/Schedule';
import { ToastProvider } from '../../src/components/Toast';
import { makeAppointment, makeEligibility, makePatient } from '../helpers/fixtures';

vi.mock('../../src/api/client');
import * as api from '../../src/api/client';

beforeEach(() => {
  for (const fn of Object.values(api)) (fn as any).mockReset?.();
  api.getAppointments.mockResolvedValue([]);
  api.getPatients.mockResolvedValue([]);
});

function renderSchedule() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <Schedule />
      </ToastProvider>
    </MemoryRouter>,
  );
}

/**
 * Spec: the schedule mirrors Google Calendar and shows OHIP status per
 * appointment, so the front desk can see coverage at a glance instead of
 * checking each one by hand.
 */
describe('Schedule', () => {
  it('explains the empty state and where appointments come from', async () => {
    renderSchedule();
    expect(await screen.findByText(/mirror your Google Calendar/i)).toBeInTheDocument();
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
    api.checkAppointmentEligibility.mockResolvedValue({ ...makeEligibility(), checkId: 'c1' });

    renderSchedule();
    await userEvent.click(await screen.findByRole('button', { name: /Check OHIP/i }));

    await waitFor(() => expect(api.checkAppointmentEligibility).toHaveBeenCalledWith('appt-1'));
    expect(await screen.findByText(/Coverage confirmed/i)).toBeInTheDocument();
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
