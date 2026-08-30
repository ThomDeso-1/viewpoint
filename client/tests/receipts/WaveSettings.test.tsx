import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WaveSettings } from '../../src/receipts/WaveSettings';
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
};

function renderPanel(settings: SettingsData | null, onSaved = vi.fn()) {
  render(
    <ToastProvider>
      <WaveSettings settings={settings} waveHealthy={false} onSaved={onSaved} />
    </ToastProvider>,
  );
  return onSaved;
}

/**
 * Spec: a user who skipped onboarding must be able to connect Wave from
 * Settings — no hand-editing `.env`. Same token → business → accounts
 * flow the wizard runs.
 */
describe('WaveSettings', () => {
  it('runs token → business → accounts and saves without touching .env', async () => {
    api.validateWaveToken.mockResolvedValue({
      valid: true,
      businesses: [{ id: 'biz-1', name: 'Acme Co', isPersonal: false }],
    });
    api.saveWaveConnection.mockResolvedValue({ success: true });
    api.getWaveAccounts.mockResolvedValue({
      expense: [{ id: 'exp-1', name: 'Office Supplies' }],
      anchor: [{ id: 'anc-1', name: 'Chequing' }],
    });
    api.getWaveTaxes.mockResolvedValue([]);
    api.saveWaveAccounts.mockResolvedValue({ success: true });
    const onSaved = renderPanel(baseSettings);

    await userEvent.click(screen.getByRole('button', { name: /connect wave/i }));
    await userEvent.type(screen.getByLabelText(/access token/i), 'wave-tok');
    await userEvent.click(screen.getByRole('button', { name: /^connect$/i }));

    await userEvent.click(await screen.findByRole('button', { name: /acme co/i }));

    // Single-option account lists are pre-selected by the flow.
    await userEvent.click(await screen.findByRole('button', { name: /^save$/i }));

    await waitFor(() =>
      expect(api.saveWaveAccounts).toHaveBeenCalledWith({
        expenseAccountId: 'exp-1',
        anchorAccountId: 'anc-1',
        salesTaxId: '',
      }),
    );
    expect(api.saveWaveConnection).toHaveBeenCalledWith({
      token: 'wave-tok',
      businessId: 'biz-1',
      businessName: 'Acme Co',
    });
    expect(onSaved).toHaveBeenCalled();
  });

  it('surfaces a rejected token instead of advancing', async () => {
    api.validateWaveToken.mockResolvedValue({ valid: false, error: 'Token expired.' });
    renderPanel(baseSettings);

    await userEvent.click(screen.getByRole('button', { name: /connect wave/i }));
    await userEvent.type(screen.getByLabelText(/access token/i), 'stale');
    await userEvent.click(screen.getByRole('button', { name: /^connect$/i }));

    expect(await screen.findByText('Token expired.')).toBeInTheDocument();
    expect(api.saveWaveConnection).not.toHaveBeenCalled();
  });
});
