import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AuditLog } from '../../src/pages/AuditLog';
import { ToastProvider } from '../../src/components/Toast';
import type { AuditEntry } from '../../src/api/client';

vi.mock('../../src/api/client');
import * as api from '../../src/api/client';

function entry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    id: 1,
    at: '2026-08-20T12:00:00.000Z',
    action: 'patient.read',
    entity_type: 'patient',
    entity_id: 'abcdef1234',
    detail: null,
    ip: '127.0.0.1',
    ...overrides,
  };
}

beforeEach(() => {
  for (const fn of Object.values(api)) (fn as any).mockReset?.();
  api.getAuditLog.mockResolvedValue([]);
});

function renderLog() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <AuditLog />
      </ToastProvider>
    </MemoryRouter>,
  );
}

/**
 * Spec (SECURITY.md): PHIPA expects a record of who touched personal
 * health information and of anything sent to a patient. This is the read
 * side of that.
 */
describe('AuditLog', () => {
  it('shows an empty state when nothing has happened', async () => {
    renderLog();
    expect(await screen.findByText(/Nothing recorded yet/i)).toBeInTheDocument();
  });

  it('renders entries with readable action names', async () => {
    api.getAuditLog.mockResolvedValue([
      entry({ id: 2, action: 'health_card.decrypt', detail: 'OHIP eligibility check' }),
      entry({ id: 1, action: 'login.success' }),
    ]);
    renderLog();

    expect(await screen.findByText('Read health card')).toBeInTheDocument();
    expect(screen.getByText('Signed in')).toBeInTheDocument();
    expect(screen.getByText(/OHIP eligibility check/)).toBeInTheDocument();
  });

  it('falls back to the raw action for anything unrecognised', async () => {
    api.getAuditLog.mockResolvedValue([entry({ action: 'something.new' })]);
    renderLog();

    expect(await screen.findByText('something.new')).toBeInTheDocument();
  });

  it('filters to patient data only', async () => {
    api.getAuditLog.mockResolvedValue([
      entry({ id: 3, action: 'patient.read' }),
      entry({ id: 2, action: 'login.success' }),
      entry({ id: 1, action: 'reminder.send' }),
    ]);
    renderLog();
    await screen.findByText('Viewed patient');

    await userEvent.click(screen.getByRole('button', { name: 'Patient data' }));

    expect(screen.getByText('Viewed patient')).toBeInTheDocument();
    expect(screen.queryByText('Signed in')).not.toBeInTheDocument();
    expect(screen.queryByText('Sent reminder')).not.toBeInTheDocument();
  });

  it('filters to things sent to patients', async () => {
    api.getAuditLog.mockResolvedValue([
      entry({ id: 3, action: 'reminder.send' }),
      entry({ id: 2, action: 'invoice.send' }),
      entry({ id: 1, action: 'patient.read' }),
    ]);
    renderLog();
    await screen.findByText('Sent reminder');

    await userEvent.click(screen.getByRole('button', { name: 'Sent to patients' }));

    expect(screen.getByText('Sent reminder')).toBeInTheDocument();
    expect(screen.getByText('Sent invoice')).toBeInTheDocument();
    expect(screen.queryByText('Viewed patient')).not.toBeInTheDocument();
  });

  it('returns to everything when All is chosen again', async () => {
    api.getAuditLog.mockResolvedValue([
      entry({ id: 2, action: 'patient.read' }),
      entry({ id: 1, action: 'login.success' }),
    ]);
    renderLog();
    await screen.findByText('Viewed patient');

    await userEvent.click(screen.getByRole('button', { name: 'Patient data' }));
    expect(screen.queryByText('Signed in')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(screen.getByText('Signed in')).toBeInTheDocument();
  });

  it('shortens entity ids rather than printing them in full', async () => {
    api.getAuditLog.mockResolvedValue([entry({ entity_id: 'abcdef1234567890' })]);
    renderLog();

    await screen.findByText('Viewed patient');
    expect(screen.getByText(/patient abcdef12/)).toBeInTheDocument();
    expect(screen.queryByText(/abcdef1234567890/)).not.toBeInTheDocument();
  });
});
