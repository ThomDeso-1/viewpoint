import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Onboarding } from '../../src/pages/Onboarding';

vi.mock('../../src/api/client');
import * as api from '../../src/api/client';

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
});

function renderWizard(onComplete = vi.fn()) {
  render(
    <MemoryRouter>
      <Onboarding onComplete={onComplete} />
    </MemoryRouter>,
  );
  return onComplete;
}

/**
 * Spec (CONVERSION-PLAN.md "Phase 3: Onboarding Wizard"): three steps —
 * password (already done before this component mounts), Claude API key,
 * then Wave (token -> business -> accounts). Either the Claude or Wave
 * step can be skipped. Wave's account step pre-selects the account
 * automatically when there's only one option (GETTING-STARTED.md doesn't
 * spell this out, but Onboarding.tsx's own logic does).
 */
describe('Onboarding: Claude step', () => {
  it('disables Validate & Continue with an empty key', () => {
    renderWizard();
    expect(screen.getByRole('button', { name: /validate & continue/i })).toBeDisabled();
  });

  it('validates the key, saves it, and advances to the Wave step on success', async () => {
    api.validateClaudeKey.mockResolvedValue({ valid: true });
    api.saveClaudeKey.mockResolvedValue({ success: true });
    renderWizard();

    await userEvent.type(screen.getByPlaceholderText('sk-ant-…'), 'sk-ant-good');
    await userEvent.click(screen.getByRole('button', { name: /validate & continue/i }));

    expect(api.validateClaudeKey).toHaveBeenCalledWith('sk-ant-good');
    expect(await screen.findByText(/connect wave/i)).toBeInTheDocument();
    expect(api.saveClaudeKey).toHaveBeenCalledWith('sk-ant-good');
  });

  it('shows the validation error and does NOT save or advance when the key is invalid', async () => {
    api.validateClaudeKey.mockResolvedValue({ valid: false, error: 'That key looks wrong.' });
    renderWizard();

    await userEvent.type(screen.getByPlaceholderText('sk-ant-…'), 'sk-ant-bad');
    await userEvent.click(screen.getByRole('button', { name: /validate & continue/i }));

    expect(await screen.findByText('That key looks wrong.')).toBeInTheDocument();
    expect(api.saveClaudeKey).not.toHaveBeenCalled();
    expect(screen.queryByText(/connect wave/i)).not.toBeInTheDocument();
  });

  it('skipping the Claude step advances straight to Wave without validating anything', async () => {
    renderWizard();
    await userEvent.click(screen.getByRole('button', { name: /skip for now/i }));
    expect(await screen.findByText(/connect wave/i)).toBeInTheDocument();
    expect(api.validateClaudeKey).not.toHaveBeenCalled();
  });
});

describe('Onboarding: Wave step', () => {
  async function skipToWave() {
    renderWizard();
    await userEvent.click(screen.getByRole('button', { name: /skip for now/i }));
    await screen.findByText(/connect wave/i);
  }

  it('validates the token and lists businesses to choose from', async () => {
    api.validateWaveToken.mockResolvedValue({
      valid: true,
      businesses: [
        { id: 'b1', name: 'Acme Co', isPersonal: false },
        { id: 'b2', name: "Thomas's Account", isPersonal: true },
      ],
    });
    await skipToWave();

    await userEvent.type(screen.getByPlaceholderText('Wave access token'), 'wave-token');
    await userEvent.click(screen.getByRole('button', { name: /^connect$/i }));

    expect(await screen.findByText('Acme Co')).toBeInTheDocument();
    expect(screen.getByText("Thomas's Account")).toBeInTheDocument();
    // Only the personal business gets the "Personal" badge.
    expect(screen.getByText('Personal', { selector: '.settings-not-set' })).toBeInTheDocument();
  });

  it('shows an error for an invalid token without advancing', async () => {
    api.validateWaveToken.mockResolvedValue({ valid: false, error: 'Bad token.' });
    await skipToWave();

    await userEvent.type(screen.getByPlaceholderText('Wave access token'), 'bad');
    await userEvent.click(screen.getByRole('button', { name: /^connect$/i }));

    expect(await screen.findByText('Bad token.')).toBeInTheDocument();
    expect(screen.queryByText(/choose a business/i)).not.toBeInTheDocument();
  });

  it('selecting a business saves the connection, loads accounts, and pre-selects a sole account of each kind', async () => {
    api.validateWaveToken.mockResolvedValue({
      valid: true,
      businesses: [{ id: 'b1', name: 'Acme Co', isPersonal: false }],
    });
    api.saveWaveConnection.mockResolvedValue({ success: true });
    api.getWaveAccounts.mockResolvedValue({
      expense: [{ id: 'exp1', name: 'Office Supplies' }],
      anchor: [{ id: 'anc1', name: 'Chequing' }],
    });
    api.getWaveTaxes.mockResolvedValue([{ id: 'tax1', name: 'HST', rate: 0.13 }]);

    await skipToWave();
    await userEvent.type(screen.getByPlaceholderText('Wave access token'), 'wave-token');
    await userEvent.click(screen.getByRole('button', { name: /^connect$/i }));
    await userEvent.click(await screen.findByText('Acme Co'));

    expect(api.saveWaveConnection).toHaveBeenCalledWith({
      token: 'wave-token',
      businessId: 'b1',
      businessName: 'Acme Co',
    });

    await screen.findByLabelText('Expense account');
    expect(screen.getByLabelText('Expense account')).toHaveValue('exp1');
    expect(screen.getByLabelText('Paid from')).toHaveValue('anc1');
  });

  it('does not pre-select when there are multiple accounts of a kind', async () => {
    api.validateWaveToken.mockResolvedValue({ valid: true, businesses: [{ id: 'b1', name: 'Acme', isPersonal: false }] });
    api.saveWaveConnection.mockResolvedValue({ success: true });
    api.getWaveAccounts.mockResolvedValue({
      expense: [
        { id: 'exp1', name: 'Office Supplies' },
        { id: 'exp2', name: 'Travel' },
      ],
      anchor: [{ id: 'anc1', name: 'Chequing' }],
    });
    api.getWaveTaxes.mockResolvedValue([]);

    await skipToWave();
    await userEvent.type(screen.getByPlaceholderText('Wave access token'), 'wave-token');
    await userEvent.click(screen.getByRole('button', { name: /^connect$/i }));
    await userEvent.click(await screen.findByText('Acme'));

    await screen.findByLabelText('Expense account');
    expect(screen.getByLabelText('Expense account')).toHaveValue('');
  });

  it('requires both accounts before Finish Setup is enabled', async () => {
    api.validateWaveToken.mockResolvedValue({ valid: true, businesses: [{ id: 'b1', name: 'Acme', isPersonal: false }] });
    api.saveWaveConnection.mockResolvedValue({ success: true });
    api.getWaveAccounts.mockResolvedValue({
      expense: [{ id: 'exp1', name: 'Office Supplies' }, { id: 'exp2', name: 'Travel' }],
      anchor: [],
    });
    api.getWaveTaxes.mockResolvedValue([]);

    await skipToWave();
    await userEvent.type(screen.getByPlaceholderText('Wave access token'), 'wave-token');
    await userEvent.click(screen.getByRole('button', { name: /^connect$/i }));
    await userEvent.click(await screen.findByText('Acme'));
    await screen.findByLabelText('Expense account');

    expect(screen.getByRole('button', { name: /finish setup/i })).toBeDisabled();
  });

  it('finishing saves the account selections, marks onboarding complete, and calls onComplete', async () => {
    api.validateWaveToken.mockResolvedValue({ valid: true, businesses: [{ id: 'b1', name: 'Acme', isPersonal: false }] });
    api.saveWaveConnection.mockResolvedValue({ success: true });
    api.getWaveAccounts.mockResolvedValue({
      expense: [{ id: 'exp1', name: 'Office Supplies' }],
      anchor: [{ id: 'anc1', name: 'Chequing' }],
    });
    api.getWaveTaxes.mockResolvedValue([{ id: 'tax1', name: 'HST', rate: 0.13 }]);
    api.saveWaveAccounts.mockResolvedValue({ success: true });
    api.markOnboarded.mockResolvedValue({ success: true });
    const onComplete = vi.fn();

    renderWizard(onComplete);
    await userEvent.click(screen.getByRole('button', { name: /skip for now/i }));
    await screen.findByText(/connect wave/i);
    await userEvent.type(screen.getByPlaceholderText('Wave access token'), 'wave-token');
    await userEvent.click(screen.getByRole('button', { name: /^connect$/i }));
    await userEvent.click(await screen.findByText('Acme'));
    await screen.findByLabelText('Expense account');

    await userEvent.click(screen.getByRole('button', { name: /finish setup/i }));

    expect(api.saveWaveAccounts).toHaveBeenCalledWith({
      expenseAccountId: 'exp1',
      anchorAccountId: 'anc1',
      salesTaxId: '',
    });
    expect(api.markOnboarded).toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalled();
  });

  it('skipping Wave entirely still finishes onboarding', async () => {
    api.markOnboarded.mockResolvedValue({ success: true });
    const onComplete = vi.fn();
    renderWizard(onComplete);

    await userEvent.click(screen.getByRole('button', { name: /skip for now/i }));
    await screen.findByText(/connect wave/i);
    await userEvent.click(screen.getByRole('button', { name: /skip for now/i }));

    expect(api.markOnboarded).toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalled();
    expect(api.saveWaveConnection).not.toHaveBeenCalled();
  });
});
