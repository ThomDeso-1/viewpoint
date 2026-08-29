import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Patients } from '../../src/exams/Patients';
import { ToastProvider } from '../../src/shared/Toast';
import { makePatient } from '../helpers/fixtures';

vi.mock('../../src/shared/api');
import * as api from '../../src/shared/api';

beforeEach(() => {
  for (const fn of Object.values(api)) (fn as any).mockReset?.();
  api.getPatients.mockResolvedValue([]);
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
 * numbers are only ever shown masked.
 */
describe('Patients', () => {
  it('explains that records arrive automatically when empty', async () => {
    renderPatients();
    expect(await screen.findByText(/created automatically when an exam request comes in/i)).toBeInTheDocument();
  });

  it('lists patients with their contact details', async () => {
    api.getPatients.mockResolvedValue([
      makePatient(),
      makePatient({ id: 'p2', full_name: 'Bob Jones', email: 'bob@example.com' }),
    ]);
    renderPatients();

    expect(await screen.findByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('Bob Jones')).toBeInTheDocument();
    expect(screen.getByText('2 of 2')).toBeInTheDocument();
  });

  it('shows the health card masked, never in full', async () => {
    api.getPatients.mockResolvedValue([makePatient()]);
    const { container } = renderPatients();

    await screen.findByText('Ada Lovelace');
    expect(screen.getByText('•••• ••7890')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/\b\d{10}\b/);
  });

  it('flags a patient with no health card on file', async () => {
    api.getPatients.mockResolvedValue([
      makePatient({ has_health_card: false, health_card_masked: null }),
    ]);
    renderPatients();

    expect(await screen.findByText('No health card')).toBeInTheDocument();
  });

  it('filters by name', async () => {
    api.getPatients.mockResolvedValue([
      makePatient(),
      makePatient({ id: 'p2', full_name: 'Bob Jones', email: 'bob@example.com' }),
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
      makePatient(),
      makePatient({ id: 'p2', full_name: 'Bob Jones', email: 'bob@example.com' }),
    ]);
    renderPatients();
    await screen.findByText('Ada Lovelace');

    await userEvent.type(screen.getByLabelText('Search patients'), 'bob@');
    expect(screen.getByText('Bob Jones')).toBeInTheDocument();
  });

  it('reports when a search matches nobody', async () => {
    api.getPatients.mockResolvedValue([makePatient()]);
    renderPatients();
    await screen.findByText('Ada Lovelace');

    await userEvent.type(screen.getByLabelText('Search patients'), 'zzz');
    expect(screen.getByText(/No patients match/i)).toBeInTheDocument();
  });
});
