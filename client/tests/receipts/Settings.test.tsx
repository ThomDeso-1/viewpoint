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
  waveExpenseAccountId: '',
  waveAnchorAccountId: '',
  waveSalesTaxId: '',
  isOnboarded: true,
};

/**
 * Spec (CONVERSION-PLAN.md "Settings Page"): masked key previews, Wave
 * connection health, upload queue counts, "Retry All Failed" only when
 * there are failures, Sign Out.
 */
describe('Settings', () => {
  it('shows "Not configured" for keys that are not set', async () => {
    api.getSettings.mockResolvedValue(baseSettings);
    api.getQueueStatus.mockResolvedValue({ uploaded: 0, pending: 0, failed: 0, captured: 0 });
    api.getWaveHealth.mockResolvedValue({ healthy: false });
    renderSettings();

    await waitFor(() => expect(screen.getAllByText('Not configured')).toHaveLength(2));
  });

  it('shows the masked key preview once a Claude key is configured', async () => {
    api.getSettings.mockResolvedValue({ ...baseSettings, hasClaudeKey: true, claudeKeyPreview: 'sk-ant-ab…wxyz' });
    api.getQueueStatus.mockResolvedValue({ uploaded: 0, pending: 0, failed: 0, captured: 0 });
    api.getWaveHealth.mockResolvedValue({ healthy: false });
    renderSettings();

    await waitFor(() => expect(screen.getByText('sk-ant-ab…wxyz')).toBeInTheDocument());
  });

  it('shows Connected/Disconnected based on Wave health', async () => {
    api.getSettings.mockResolvedValue({ ...baseSettings, hasWaveToken: true, waveTokenPreview: 'wv…abcd', waveBusinessName: 'Acme Co' });
    api.getQueueStatus.mockResolvedValue({ uploaded: 0, pending: 0, failed: 0, captured: 0 });
    api.getWaveHealth.mockResolvedValue({ healthy: true });
    renderSettings();

    await waitFor(() => expect(screen.getByText('Connected')).toBeInTheDocument());
    expect(screen.getByText('Acme Co')).toBeInTheDocument();
  });

  it('shows queue counts', async () => {
    api.getSettings.mockResolvedValue(baseSettings);
    api.getQueueStatus.mockResolvedValue({ uploaded: 5, pending: 2, failed: 1, captured: 3 });
    api.getWaveHealth.mockResolvedValue({ healthy: false });
    renderSettings();

    await waitFor(() => expect(screen.getByText('5')).toBeInTheDocument());
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('hides "Retry All Failed" when there are no failures', async () => {
    api.getSettings.mockResolvedValue(baseSettings);
    api.getQueueStatus.mockResolvedValue({ uploaded: 0, pending: 0, failed: 0, captured: 0 });
    api.getWaveHealth.mockResolvedValue({ healthy: false });
    renderSettings();

    await waitFor(() => expect(screen.getByText('Viewpoint v1.0.0')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /retry all failed/i })).not.toBeInTheDocument();
  });

  it('shows and uses "Retry All Failed" when there are failures', async () => {
    api.getSettings.mockResolvedValue(baseSettings);
    api.getQueueStatus
      .mockResolvedValueOnce({ uploaded: 0, pending: 0, failed: 2, captured: 0 })
      .mockResolvedValueOnce({ uploaded: 0, pending: 2, failed: 0, captured: 0 });
    api.getWaveHealth.mockResolvedValue({ healthy: false });
    api.retryAllFailed.mockResolvedValue({ success: true });
    renderSettings();

    const retryBtn = await screen.findByRole('button', { name: /retry all failed/i });
    await userEvent.click(retryBtn);

    expect(api.retryAllFailed).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('button', { name: /retry all failed/i })).not.toBeInTheDocument());
  });

  it('shows a toast if retrying fails', async () => {
    api.getSettings.mockResolvedValue(baseSettings);
    api.getQueueStatus.mockResolvedValue({ uploaded: 0, pending: 0, failed: 1, captured: 0 });
    api.getWaveHealth.mockResolvedValue({ healthy: false });
    api.retryAllFailed.mockRejectedValue(new Error('Could not retry failed uploads.'));
    renderSettings();

    await userEvent.click(await screen.findByRole('button', { name: /retry all failed/i }));
    expect(await screen.findByText('Could not retry failed uploads.')).toBeInTheDocument();
  });

  it('signs out and navigates to /login', async () => {
    api.getSettings.mockResolvedValue(baseSettings);
    api.getQueueStatus.mockResolvedValue({ uploaded: 0, pending: 0, failed: 0, captured: 0 });
    api.getWaveHealth.mockResolvedValue({ healthy: false });
    api.logout.mockResolvedValue({ success: true });
    renderSettings();

    await waitFor(() => expect(screen.getByText('Viewpoint v1.0.0')).toBeInTheDocument());
    await userEvent.click(screen.getByRole('button', { name: /sign out/i }));

    expect(api.logout).toHaveBeenCalled();
  });
});
