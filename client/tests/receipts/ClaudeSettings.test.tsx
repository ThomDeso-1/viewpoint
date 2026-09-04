import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ClaudeSettings } from '../../src/receipts/ClaudeSettings';
import { ToastProvider } from '../../src/shared/Toast';
import type { Settings as SettingsData } from '../../src/shared/api';

vi.mock('../../src/shared/api');
import * as api from '../../src/shared/api';

beforeEach(() => {
  for (const fn of Object.values(api)) (fn as any).mockReset?.();
});

const baseSettings: SettingsData = {
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
};

function renderPanel(settings: SettingsData | null, onSaved = vi.fn()) {
  render(
    <ToastProvider>
      <ClaudeSettings settings={settings} onSaved={onSaved} />
    </ToastProvider>,
  );
  return onSaved;
}

/**
 * Spec: a user who skipped onboarding must be able to add the Claude key
 * from Settings — no hand-editing `.env`. The key is validated before it
 * is saved, same as the wizard.
 */
describe('ClaudeSettings', () => {
  it('validates then saves a new key and tells the parent to reload', async () => {
    api.validateClaudeKey.mockResolvedValue({ valid: true });
    api.saveClaudeKey.mockResolvedValue({ success: true });
    const onSaved = renderPanel(baseSettings);

    await userEvent.click(screen.getByRole('button', { name: /add key/i }));
    await userEvent.type(screen.getByLabelText(/api key/i), 'sk-ant-newkey');
    await userEvent.click(screen.getByRole('button', { name: /validate & save/i }));

    await waitFor(() => expect(api.saveClaudeKey).toHaveBeenCalledWith('sk-ant-newkey'));
    expect(api.validateClaudeKey).toHaveBeenCalledWith('sk-ant-newkey');
    expect(onSaved).toHaveBeenCalled();
  });

  it('shows the validation error and does not save a bad key', async () => {
    api.validateClaudeKey.mockResolvedValue({ valid: false, error: 'That key is not authorized.' });
    renderPanel(baseSettings);

    await userEvent.click(screen.getByRole('button', { name: /add key/i }));
    await userEvent.type(screen.getByLabelText(/api key/i), 'sk-ant-bad');
    await userEvent.click(screen.getByRole('button', { name: /validate & save/i }));

    expect(await screen.findByText('That key is not authorized.')).toBeInTheDocument();
    expect(api.saveClaudeKey).not.toHaveBeenCalled();
  });

  it('offers to replace an already-configured key', async () => {
    renderPanel({ ...baseSettings, hasClaudeKey: true, claudeKeyPreview: 'sk-ant-ab…wxyz' });

    expect(screen.getByText('sk-ant-ab…wxyz')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /replace key/i })).toBeInTheDocument();
  });
});
