import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Patients } from '../../src/exams/Patients';
import { ToastProvider } from '../../src/shared/Toast';
import { makePatientRow, makeFollowupDue } from '../helpers/fixtures';

vi.mock('../../src/shared/api');
import * as api from '../../src/shared/api';

beforeEach(() => {
  for (const fn of Object.values(api)) (fn as any).mockReset?.();
  api.getPatients.mockResolvedValue([]);
  api.getFollowupsDue.mockResolvedValue({ due: [] });
});

function renderPatients() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <Patients />
      </ToastProvider>
    </MemoryRouter>,
  );
}

/**
 * Spec: a directory for finding someone, not a data-entry screen —
 * records are created automatically from exam requests. Health card
 * numbers are only ever shown masked. A separate "Follow-ups due" section
 * lists patients whose next eye exam is coming up or overdue.
 */
describe('Patients', () => {
  it('explains that records arrive automatically when empty', async () => {
    renderPatients();
    expect(
      await screen.findByText(/created automatically when an exam request comes in/i),
    ).toBeInTheDocument();
  });

  it('lists patients with their contact details', async () => {
    api.getPatients.mockResolvedValue([
      makePatientRow(),
      makePatientRow({ id: 'p2', full_name: 'Bob Jones', email: 'bob@example.com' }),
    ]);
    renderPatients();

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('Bob Jones')).toBeInTheDocument();
    expect(screen.getByText('2 of 2')).toBeInTheDocument();
  });

  it('shows the health card masked, never in full', async () => {
    api.getPatients.mockResolvedValue([makePatientRow()]);
    const { container } = renderPatients();

    await screen.findByText('Ada Lovelace');
    expect(screen.getByText('•••• ••7890')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\b\d{10}\b/);
  });

  it('flags a patient with no health card on file', async () => {
    api.getPatients.mockResolvedValue([
      makePatientRow({ has_health_card: false, health_card_masked: null }),
    ]);
    renderPatients();

    expect(await screen.findByText('No health card')).toBeInTheDocument();
  });

  it('filters by name', async () => {
    api.getPatients.mockResolvedValue([
      makePatientRow(),
      makePatientRow({ id: 'p2', full_name: 'Bob Jones', email: 'bob@example.com' }),
    ]);
    renderPatients();
    await screen.findByText('Ada Lovelace');

    await userEvent.type(screen.getByLabelText('Search patients'), 'bob');

    expect(screen.queryByText('Ada Lovelace')).not.toBeInTheDocument();
    expect(screen.getByText('Bob Jones')).toBeInTheDocument();
    expect(screen.getByText('1 of 2')).toBeInTheDocument();
  });

  it('filters by email too', async () => {
    api.getPatients.mockResolvedValue([
      makePatientRow(),
      makePatientRow({ id: 'p2', full_name: 'Bob Jones', email: 'bob@example.com' }),
    ]);
    renderPatients();
    await screen.findByText('Ada Lovelace');

    await userEvent.type(screen.getByLabelText('Search patients'), 'bob@');
    expect(screen.getByText('Bob Jones')).toBeInTheDocument();
  });

  it('reports when a search matches nobody', async () => {
    api.getPatients.mockResolvedValue([makePatientRow()]);
    renderPatients();
    await screen.findByText('Ada Lovelace');

    await userEvent.type(screen.getByLabelText('Search patients'), 'zzz');
    expect(screen.getByText(/No patients match/i)).toBeInTheDocument();
  });

  it('shows the last and follow-up appointment on the row', async () => {
    api.getPatients.mockResolvedValue([
      makePatientRow(
        {},
        {
          last_appointment_at: '2024-08-01T14:00:00.000Z',
          followup_date: '2026-08-01',
          followup_source: 'computed',
          due: true,
        },
      ),
    ]);
    renderPatients();

    await screen.findByText('Ada Lovelace');
    expect(screen.getByText(/Last: .*2024/)).toBeInTheDocument();
    expect(screen.getByText(/Follow-up: .*2026/)).toBeInTheDocument();
    expect(screen.getByText('due')).toBeInTheDocument();
  });

  it('labels a booked upcoming appointment as current', async () => {
    api.getPatients.mockResolvedValue([
      makePatientRow(
        {},
        { current_appointment_at: '2026-10-01T14:00:00.000Z', followup_source: 'booked' },
      ),
    ]);
    renderPatients();

    await screen.findByText('Ada Lovelace');
    expect(screen.getByText(/Current: .*2026/)).toBeInTheDocument();
  });

  describe('Follow-ups due section', () => {
    it('shows the count on the toggle and lists due patients', async () => {
      api.getFollowupsDue.mockResolvedValue({
        due: [makeFollowupDue({ full_name: 'Grace Hopper' })],
      });
      renderPatients();

      const toggle = await screen.findByRole('button', { name: /Follow-ups due \(1\)/ });
      await userEvent.click(toggle);

      expect(await screen.findByText('Grace Hopper')).toBeInTheDocument();
    });

    it('snoozes a follow-up', async () => {
      api.getFollowupsDue.mockResolvedValue({ due: [makeFollowupDue()] });
      api.snoozeFollowup.mockResolvedValue({ followup: {} as any });
      renderPatients();

      await userEvent.click(await screen.findByRole('button', { name: /Follow-ups due/ }));
      await userEvent.click(await screen.findByRole('button', { name: /Snooze 1 month/ }));

      expect(api.snoozeFollowup).toHaveBeenCalledWith('patient-1', 1);
    });

    it('marks a follow-up done', async () => {
      api.getFollowupsDue.mockResolvedValue({ due: [makeFollowupDue()] });
      api.dismissFollowup.mockResolvedValue({ followup: {} as any });
      renderPatients();

      await userEvent.click(await screen.findByRole('button', { name: /Follow-ups due/ }));
      await userEvent.click(await screen.findByRole('button', { name: 'Done' }));

      expect(api.dismissFollowup).toHaveBeenCalledWith('patient-1');
    });

    it('only offers the recall email for "followup" patients with an address', async () => {
      api.getFollowupsDue.mockResolvedValue({
        due: [
          makeFollowupDue({ patient_id: 'a', full_name: 'Remind Only', mode: 'remind' }),
          makeFollowupDue({ patient_id: 'b', full_name: 'No Email', email: null }),
        ],
      });
      renderPatients();

      await userEvent.click(await screen.findByRole('button', { name: /Follow-ups due/ }));
      await screen.findByText('Remind Only');
      expect(screen.queryByRole('button', { name: 'Draft email' })).not.toBeInTheDocument();
    });

    it('reports an all-clear when nothing is due', async () => {
      renderPatients();
      await userEvent.click(await screen.findByRole('button', { name: /Follow-ups due/ }));
      expect(await screen.findByText(/No follow-ups due/i)).toBeInTheDocument();
    });
  });
});
