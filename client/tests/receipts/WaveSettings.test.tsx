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
  waveSalesTaxId: '',
  isOnboarded: true,
  microsoftConnected: false,
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
 * Settings — no hand-editing `.env`. Token → business → sales tax (for
 * exam invoices; the expense/anchor account pickers went with the
 * receipt upload queue).
 */
describe('WaveSettings', () => {
  it('runs token → business → sales tax and saves without touching .env', async () => {
    api.validateWaveToken.mockResolvedValue({
      valid: true,
      businesses: [{ id: 'biz-1', name: 'Acme Co', isPersonal: false }],
    });
    api.saveWaveConnection.mockResolvedValue({ success: true });
    api.getWaveTaxes.mockResolvedValue([{ id: 'tax-hst', name: 'HST', rate: 0.13 }]);
    api.saveWaveSalesTax.mockResolvedValue({ success: true });
    const onSaved = renderPanel(baseSettings);

    await userEvent.click(screen.getByRole('button', { name: /connect wave/i }));
    await userEvent.type(screen.getByLabelText(/access token/i), 'wave-tok');
    await userEvent.click(screen.getByRole('button', { name: /^connect$/i }));

    await userEvent.click(await screen.findByRole('button', { name: /acme co/i }));

    expect(screen.queryByLabelText(/expense account/i)).not.toBeInTheDocument();
    await userEvent.selectOptions(await screen.findByLabelText(/sales tax/i), 'tax-hst');
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }));

    await waitFor(() => expect(api.saveWaveSalesTax).toHaveBeenCalledWith('tax-hst'));
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
