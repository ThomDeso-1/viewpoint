import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Schedule } from '../../src/exams/Schedule';
import { ToastProvider } from '../../src/shared/Toast';
import { makeAppointment, makePatient } from '../helpers/fixtures';

vi.mock('../../src/shared/api');
import * as api from '../../src/shared/api';

/** An appointment an hour from now — always inside the default month/week view. */
function soonAppointment(over = {}) {
  const start = new Date(Date.now() + 3_600_000);
  return {
    ...makeAppointment({
      starts_at: start.toISOString(),
      ends_at: new Date(start.getTime() + 30 * 60_000).toISOString(),
    }),
    ...over,
  };
}

beforeEach(() => {
  // Narrow viewport → FullCalendar starts in the agenda (list) view, which
  // renders real DOM in jsdom (the grid views need layout measurement).
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 500 });

  for (const fn of Object.values(api)) (fn as any).mockReset?.();
  api.getAppointments.mockResolvedValue([]);
  api.getPatients.mockResolvedValue([]);
  api.getCalendarSyncStatus.mockResolvedValue({
    connected: true,
    calendarId: 'primary',
    lastSyncedAt: new Date().toISOString(),
  });
});

function renderSchedule({ ohipEnabled = false }: { ohipEnabled?: boolean } = {}) {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <Schedule ohipEnabled={ohipEnabled} />
      </ToastProvider>
    </MemoryRouter>,
  );
}

/**
 * Spec: the Schedule is a real calendar view of the Outlook calendar.
 * Clicking an event opens its detail panel (covered in
 * AppointmentDetail.test.tsx); this file covers the calendar shell.
 */
describe('Schedule', () => {
  it('renders the calendar toolbar', async () => {
    renderSchedule();
    expect(await screen.findByRole('button', { name: 'Agenda' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Month' })).toBeInTheDocument();
  });

  /** Waits for FullCalendar's agenda to finish painting, then clicks the first event. */
  async function clickFirstEvent() {
    await waitFor(() => expect(document.querySelector('.fc-list-event-title a')).toBeTruthy(), {
      timeout: 4000,
    });
    // FullCalendar repaints the list once more after the first pass; re-query fresh.
    await new Promise((r) => setTimeout(r, 60));
    fireEvent.click(document.querySelector<HTMLElement>('.fc-list-event-title a')!);
  }

  it('fetches appointments for the visible range and shows them', async () => {
    api.getAppointments.mockResolvedValue([
      { ...soonAppointment(), patient: makePatient(), eligibility: null },
    ]);
    renderSchedule();

    await waitFor(() => expect(screen.getByText('Ada Lovelace')).toBeInTheDocument(), {
      timeout: 4000,
    });
    // FullCalendar passes the visible window to the fetch.
    const [from, to] = api.getAppointments.mock.calls[0];
    expect(typeof from).toBe('string');
    expect(typeof to).toBe('string');
  });

  it('opens the detail panel when an event is clicked', async () => {
    api.getAppointments.mockResolvedValue([
      { ...soonAppointment(), patient: makePatient(), eligibility: null },
    ]);
    renderSchedule();

    await clickFirstEvent();

    await waitFor(
      () => expect(screen.getByRole('button', { name: /Cancel appointment/i })).toBeInTheDocument(),
      { timeout: 3000 },
    );
  });

  it('shows the Outlook sync line and syncs on demand', async () => {
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

  it('opens the create form from the Add button', async () => {
    api.createAppointment.mockResolvedValue(makeAppointment());
    renderSchedule();

    await userEvent.click(await screen.findByRole('button', { name: 'Add' }));
    expect(screen.getByRole('heading', { name: 'New appointment' })).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/Date and time/i), '2026-09-01T10:00');
    await userEvent.click(screen.getByRole('button', { name: /Add appointment/i }));
    await waitFor(() => expect(api.createAppointment).toHaveBeenCalled());
  });
});
