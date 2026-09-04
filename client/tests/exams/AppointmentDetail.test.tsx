import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AppointmentDetail } from '../../src/exams/AppointmentDetail';
import { ToastProvider } from '../../src/shared/Toast';
import { makeAppointment, makeEligibility, makeEligibilityOutcome, makePatient } from '../helpers/fixtures';

vi.mock('../../src/shared/api');
import * as api from '../../src/shared/api';

beforeEach(() => {
  for (const fn of Object.values(api)) (fn as any).mockReset?.();
});

function renderDetail(
  appointment = makeAppointment({ patient: makePatient() }),
  { ohipEnabled = true, onEdit = vi.fn(), onChanged = vi.fn(), onClose = vi.fn() } = {},
) {
  render(
    <MemoryRouter>
      <ToastProvider>
        <AppointmentDetail
          appointment={appointment}
          patients={[makePatient()]}
          ohipEnabled={ohipEnabled}
          onEdit={onEdit}
          onChanged={onChanged}
          onClose={onClose}
        />
      </ToastProvider>
    </MemoryRouter>,
  );
  return { onEdit, onChanged, onClose };
}

describe('AppointmentDetail', () => {
  describe('OHIP coverage', () => {
    it('shows a confirmed coverage tag', () => {
      renderDetail(makeAppointment({ patient: makePatient(), eligibility: makeEligibility() }));
      expect(screen.getByText(/OHIP covered/)).toBeInTheDocument();
    });

    it('labels a simulated result as mock', () => {
      renderDetail(
        makeAppointment({ patient: makePatient(), eligibility: makeEligibility({ mode: 'mock' }) }),
      );
      expect(screen.getByText('mock')).toBeInTheDocument();
    });

    it('shows an uncovered patient distinctly', () => {
      renderDetail(
        makeAppointment({
          patient: makePatient(),
          eligibility: makeEligibility({ is_eligible: false, response_code: '52' }),
        }),
      );
      expect(screen.getByText(/Not covered \(52\)/)).toBeInTheDocument();
    });

    it('flags an appointment that has never been checked', () => {
      renderDetail(makeAppointment({ patient: makePatient(), eligibility: null }));
      expect(screen.getByText(/OHIP not checked/i)).toBeInTheDocument();
    });

    it('re-checks coverage on demand', async () => {
      api.checkAppointmentEligibility.mockResolvedValue(makeEligibilityOutcome());
      renderDetail(makeAppointment({ patient: makePatient(), eligibility: null }));

      await userEvent.click(screen.getByRole('button', { name: /Check OHIP/i }));
      await waitFor(() => expect(api.checkAppointmentEligibility).toHaveBeenCalledWith('appt-1'));
      expect(await screen.findByText(/Coverage confirmed/i)).toBeInTheDocument();
    });

    it('hides the OHIP surfaces when the integration is off', () => {
      renderDetail(makeAppointment({ patient: makePatient(), eligibility: makeEligibility() }), {
        ohipEnabled: false,
      });
      expect(screen.queryByText(/OHIP covered/)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Check OHIP/i })).not.toBeInTheDocument();
    });
  });

  describe('linking a patient', () => {
    it('offers the patient list when none is linked', () => {
      renderDetail(makeAppointment({ patient_id: null, patient: null }));
      expect(screen.getByLabelText('Link a patient')).toBeInTheDocument();
    });

    it('links the chosen patient', async () => {
      api.linkPatientToAppointment.mockResolvedValue({ success: true });
      const { onChanged } = renderDetail(makeAppointment({ patient_id: null, patient: null }));

      await userEvent.selectOptions(screen.getByLabelText('Link a patient'), 'patient-1');
      await waitFor(() =>
        expect(api.linkPatientToAppointment).toHaveBeenCalledWith('appt-1', 'patient-1'),
      );
      expect(onChanged).toHaveBeenCalled();
    });
  });

  describe('actions', () => {
    it('renders a recurring appointment read-only with the Outlook link', () => {
      renderDetail(makeAppointment({ patient: makePatient(), is_recurring: 1 }));
      expect(screen.getByText(/Recurring — edit in Outlook/i)).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Cancel appointment/i })).not.toBeInTheDocument();
      expect(screen.getByRole('link', { name: /Open in Outlook/i })).toBeInTheDocument();
    });

    it('shows a Not synced badge for a pending push', () => {
      renderDetail(makeAppointment({ patient: makePatient(), sync_state: 'pending_push' }));
      expect(screen.getByText('Not synced')).toBeInTheDocument();
    });

    it('fires onEdit for the edit action', async () => {
      const { onEdit } = renderDetail(makeAppointment({ patient: makePatient() }));
      await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
      expect(onEdit).toHaveBeenCalled();
    });

    it('cancels after confirmation', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      api.cancelAppointment.mockResolvedValue({ appointment: makeAppointment({ status: 'cancelled' }) });
      const { onChanged } = renderDetail(makeAppointment({ patient: makePatient() }));

      await userEvent.click(screen.getByRole('button', { name: /Cancel appointment/i }));
      await waitFor(() => expect(api.cancelAppointment).toHaveBeenCalledWith('appt-1'));
      expect(onChanged).toHaveBeenCalled();
    });

    it('deletes permanently after a strong confirm', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      api.deleteAppointment.mockResolvedValue({ success: true });
      const { onClose } = renderDetail(makeAppointment({ patient: makePatient() }));

      await userEvent.click(screen.getByRole('button', { name: /Delete permanently/i }));
      await waitFor(() => expect(api.deleteAppointment).toHaveBeenCalledWith('appt-1'));
      expect(onClose).toHaveBeenCalled();
    });

    it('does not cancel if the confirm is dismissed', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(false);
      renderDetail(makeAppointment({ patient: makePatient() }));

      await userEvent.click(screen.getByRole('button', { name: /Cancel appointment/i }));
      expect(api.cancelAppointment).not.toHaveBeenCalled();
    });

    it('a cancelled appointment offers only Delete and the Outlook link', () => {
      renderDetail(makeAppointment({ patient: makePatient(), status: 'cancelled' }));
      expect(screen.getByText('Cancelled')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Cancel appointment/i })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Delete permanently/i })).toBeInTheDocument();
    });
  });
});
