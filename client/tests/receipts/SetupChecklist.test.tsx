import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SetupChecklist } from '../../src/receipts/SetupChecklist';
import type { Settings } from '../../src/shared/api';

vi.mock('../../src/shared/api');
import * as api from '../../src/shared/api';

beforeEach(() => {
  for (const fn of Object.values(api)) (fn as any).mockReset?.();
  api.getExamSettings.mockResolvedValue({ sourceFolder: '', invoicingReady: false } as any);
});

function settings(overrides: Partial<Settings> = {}): Settings {
  return {
    hasClaudeKey: false,
    claudeKeyPreview: null,
    hasWaveToken: false,
    waveTokenPreview: null,
    waveBusinessId: '',
    waveBusinessName: '',
    waveExpenseAccountId: '',
    waveAnchorAccountId: '',
    waveSalesTaxId: '',
    isOnboarded: true,
    microsoftConnected: false,
    ...overrides,
  };
}

function renderChecklist(s: Settings | null) {
  return render(
    <MemoryRouter>
      <SetupChecklist settings={s} />
    </MemoryRouter>,
  );
}

describe('SetupChecklist', () => {
  it('lists the outstanding steps with a count', async () => {
    renderChecklist(settings());
    expect(await screen.findByText(/finish setting up \(5 left\)/i)).toBeInTheDocument();
    expect(screen.getByText('Add your Claude API key')).toBeInTheDocument();
    expect(screen.getByText('Sign in with Microsoft for mail + calendar')).toBeInTheDocument();
  });

  it('counts a connected Outlook mailbox as done', async () => {
    renderChecklist(settings({ microsoftConnected: true }));
    expect(await screen.findByText(/finish setting up \(4 left\)/i)).toBeInTheDocument();
  });

  it('renders nothing once every step is done', async () => {
    api.getExamSettings.mockResolvedValue({ sourceFolder: '/files', invoicingReady: true } as any);
    const { container } = renderChecklist(
      settings({ hasClaudeKey: true, hasWaveToken: true, microsoftConnected: true }),
    );
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('can be dismissed', async () => {
    renderChecklist(settings());
    await screen.findByText(/finish setting up/i);
    await userEvent.click(screen.getByRole('button', { name: /dismiss/i }));
    expect(screen.queryByText(/finish setting up/i)).not.toBeInTheDocument();
  });
});
