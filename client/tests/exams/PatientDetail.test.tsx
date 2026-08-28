import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { PatientDetail } from '../../src/exams/PatientDetail';
import { ToastProvider } from '../../src/shared/Toast';
import { makePatient, makeAppointment, makeEligibility, makeEligibilityOutcome } from '../helpers/fixtures';

vi.mock('../../src/shared/api');
import * as api from '../../src/shared/api';

beforeEach(() => {
  for (const fn of Object.values(api)) (fn as any).mockReset?.();
  api.getPatient.mockResolvedValue({
    ...makePatient(),
    appointments: [makeAppointment()],
    eligibility_history: [makeEligibility()],
  });
  api.updatePatient.mockResolvedValue(makePatient());
});

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={['/patients/patient-1']}>
      <ToastProvider>
        <Routes>
          <Route path="/patients/:id" element={<PatientDetail />} />
        </Routes>
      </ToastProvider>
    </MemoryRouter>,
  );
}

/**
 * Spec: the record shows a patient's history, but the health card number
 * is write-only from the client's point of view — the server only ever
 * returns it masked, so saving must not be able to clear it by accident.
 */
describe('PatientDetail', () => {
  it('shows the patient with their history', async () => {
    renderDetail();

    expect(await screen.findByRole('heading', { name: 'Ada Lovelace' })).toBeInTheDocument();
    expect(screen.getByText(/Eye exam/)).toBeInTheDocument();
    expect(screen.getByText(/covered/)).toBeInTheDocument();
  });

  it('shows the health card masked, never in full', async () => {
    const { container } = renderDetail();
    await screen.findByRole('heading', { name: 'Ada Lovelace' });

    expect(screen.getByPlaceholderText('•••• ••7890')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\b\d{10}\b/);
  });

  it('omits the health card field when saving an unchanged form', async () => {
    renderDetail();
    await screen.findByRole('heading', { name: 'Ada Lovelace' });

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.updatePatient).toHaveBeenCalled());
    const [, payload] = api.updatePatient.mock.calls[0];
    // Sending health_card_number: '' would wipe the stored card.
    expect(payload).not.toHaveProperty('health_card_number');
  });

  it('sends a new health card only when one is typed', async () => {
    renderDetail();
    await screen.findByRole('heading', { name: 'Ada Lovelace' });

    await userEvent.type(screen.getByPlaceholderText('•••• ••7890'), '1234567890');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.updatePatient).toHaveBeenCalled());
    const [, payload] = api.updatePatient.mock.calls[0];
    expect(payload.health_card_number).toBe('1234567890');
  });

  it('runs an eligibility check on demand', async () => {
    api.checkPatientEligibility.mockResolvedValue(makeEligibilityOutcome());
    renderDetail();
    await screen.findByRole('heading', { name: 'Ada Lovelace' });

    await userEvent.click(screen.getByRole('button', { name: /Check OHIP now/i }));

    await waitFor(() => expect(api.checkPatientEligibility).toHaveBeenCalledWith('patient-1'));
    expect(await screen.findByText(/Coverage confirmed/i)).toBeInTheDocument();
  });

  it('cannot check a patient with no card on file', async () => {
    api.getPatient.mockResolvedValue({
      ...makePatient({ has_health_card: false, health_card_masked: null }),
      appointments: [],
      eligibility_history: [],
    });
    renderDetail();
    await screen.findByRole('heading', { name: 'Ada Lovelace' });

    expect(screen.getByRole('button', { name: /Check OHIP now/i })).toBeDisabled();
    expect(screen.getByText(/No card on file/i)).toBeInTheDocument();
  });

  it('reports a failed check instead of implying coverage', async () => {
    api.checkPatientEligibility.mockResolvedValue(
      makeEligibilityOutcome({ isEligible: null, error: 'service unavailable' }),
    );
    renderDetail();
    await screen.findByRole('heading', { name: 'Ada Lovelace' });

    await userEvent.click(screen.getByRole('button', { name: /Check OHIP now/i }));
    expect(await screen.findByText(/Check failed: service unavailable/i)).toBeInTheDocument();
  });
});
