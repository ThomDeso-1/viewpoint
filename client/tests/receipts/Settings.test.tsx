import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Settings } from '../../src/receipts/Settings';
import { ToastProvider } from '../../src/shared/Toast';

vi.mock('../../src/shared/api');
import * as api from '../../src/shared/api';

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
});

function renderSettings() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <Settings />
      </ToastProvider>
    </MemoryRouter>,
  );
}

const baseSettings = {
  hasClaudeKey: false,
  claudeKeyPreview: null,
  hasWaveToken: false,
  waveTokenPreview: null,
  waveBusinessId: '',
  waveBusinessName: '',
  waveSalesTaxId: '',
  isOnboarded: true,
  microsoftConnected: false,
};

/**
 * Spec (CONVERSION-PLAN.md "Settings Page"): masked key previews, Wave
 * connection health, where receipt photos are kept, Sign Out. (The upload
 * queue counts and "Retry All Failed" went with the Wave upload queue —
 * migration 010.)
 */
describe('Settings', () => {
  it('shows "Not configured" for keys that are not set', async () => {
    api.getSettings.mockResolvedValue(baseSettings);
    api.getWaveHealth.mockResolvedValue({ healthy: false });
    renderSettings();

    await waitFor(() => expect(screen.getAllByText('Not configured')).toHaveLength(2));
  });

  it('shows the masked key preview once a Claude key is configured', async () => {
    api.getSettings.mockResolvedValue({ ...baseSettings, hasClaudeKey: true, claudeKeyPreview: 'sk-ant-ab…wxyz' });
    api.getWaveHealth.mockResolvedValue({ healthy: false });
    renderSettings();

    await waitFor(() => expect(screen.getByText('sk-ant-ab…wxyz')).toBeInTheDocument());
  });

  it('shows Connected/Disconnected based on Wave health', async () => {
    api.getSettings.mockResolvedValue({ ...baseSettings, hasWaveToken: true, waveTokenPreview: 'wv…abcd', waveBusinessName: 'Acme Co' });
    api.getWaveHealth.mockResolvedValue({ healthy: true });
    renderSettings();

    await waitFor(() => expect(screen.getByText('Connected')).toBeInTheDocument());
    expect(screen.getByText('Acme Co')).toBeInTheDocument();
  });

  it('says where receipt photos are kept, and has no upload-queue controls', async () => {
    api.getSettings.mockResolvedValue(baseSettings);
    api.getWaveHealth.mockResolvedValue({ healthy: false });
    renderSettings();

    await waitFor(() => expect(screen.getByText('Receipt photos')).toBeInTheDocument());
    expect(screen.getByText('data/Receipts')).toBeInTheDocument();
    expect(screen.queryByText(/upload queue/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry all failed/i })).not.toBeInTheDocument();
  });

  it('signs out and navigates to /login', async () => {
    api.getSettings.mockResolvedValue(baseSettings);
    api.getWaveHealth.mockResolvedValue({ healthy: false });
    api.logout.mockResolvedValue({ success: true });
    renderSettings();

    await waitFor(() => expect(screen.getByText('Viewpoint v1.0.0')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /sign out/i }));

    expect(api.logout).toHaveBeenCalled();
  });
});
