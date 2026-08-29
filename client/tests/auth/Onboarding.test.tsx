import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Onboarding } from '../../src/auth/Onboarding';

vi.mock('../../src/shared/api');
import * as api from '../../src/shared/api';

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
 * Spec (CONVERSION-PLAN.md "Phase 3: Onboarding Wizard", extended for the
 * exam workflow): four steps — password (already done before this
 * component mounts), Claude API key, Wave (token -> business -> accounts),
 * then OHIP validation mode. Every credential step can be skipped.
 *
 * Wave's account step pre-selects the account automatically when there's
 * only one option. Skipping OHIP records `mock` explicitly rather than
 * leaving it unset, so eligibility results are always labelled simulated
 * rather than silently absent.
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

    expect(screen.getByRole('button', { name: /^continue$/i })).toBeDisabled();
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

    await userEvent.click(screen.getByRole('button', { name: /^continue$/i }));

    expect(api.saveWaveAccounts).toHaveBeenCalledWith({
      expenseAccountId: 'exp1',
      anchorAccountId: 'anc1',
      salesTaxId: '',
    });

    // Wave now hands off to the OHIP step rather than finishing.
    await screen.findByText(/ohip validation/i);
    expect(api.markOnboarded).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: /finish setup/i }));
    expect(api.saveOhipSettings).toHaveBeenCalledWith({ mode: 'mock' });
    expect(api.markOnboarded).toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalled();
  });

  it('skipping Wave advances to the OHIP step', async () => {
    api.markOnboarded.mockResolvedValue({ success: true });
    const onComplete = vi.fn();
    renderWizard(onComplete);

    await userEvent.click(screen.getByRole('button', { name: /skip for now/i }));
    await screen.findByText(/connect wave/i);
    await userEvent.click(screen.getByRole('button', { name: /skip for now/i }));

    await screen.findByText(/ohip validation/i);
    expect(api.saveWaveConnection).not.toHaveBeenCalled();
    expect(api.markOnboarded).not.toHaveBeenCalled();
  });
});

describe('Onboarding: OHIP step', () => {
  async function reachOhipStep(onComplete = vi.fn()) {
    api.markOnboarded.mockResolvedValue({ success: true });
    api.saveOhipSettings.mockResolvedValue({ success: true, mode: 'mock' });
    renderWizard(onComplete);

    await userEvent.click(screen.getByRole('button', { name: /skip for now/i }));
    await screen.findByText(/connect wave/i);
    await userEvent.click(screen.getByRole('button', { name: /skip for now/i }));
    await screen.findByText(/ohip validation/i);
    return onComplete;
  }

  it('defaults to simulated mode and explains what that means', async () => {
    await reachOhipStep();

    expect(screen.getByLabelText('Mode')).toHaveValue('mock');
    expect(screen.getByText(/results are simulated/i)).toBeInTheDocument();
  });

  it('finishes with mock mode without asking for credentials', async () => {
    const onComplete = await reachOhipStep();

    await userEvent.click(screen.getByRole('button', { name: /finish setup/i }));

    expect(api.saveOhipSettings).toHaveBeenCalledWith({ mode: 'mock' });
    expect(api.markOnboarded).toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalled();
  });

  it('skipping still records mock explicitly, so results stay labelled', async () => {
    const onComplete = await reachOhipStep();

    await userEvent.click(screen.getByRole('button', { name: /skip for now/i }));

    expect(api.saveOhipSettings).toHaveBeenCalledWith({ mode: 'mock' });
    expect(onComplete).toHaveBeenCalled();
  });

  it('asks for ministry credentials once a real mode is chosen', async () => {
    await reachOhipStep();

    await userEvent.selectOptions(screen.getByLabelText('Mode'), 'conformance');

    expect(screen.getByLabelText(/private key path/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/go secure username/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/conformance key/i)).toBeInTheDocument();
    // The openssl conversion is the step people get stuck on — one line
    // for the key, one for the certificate.
    expect(screen.getAllByText(/openssl pkcs12/i)).toHaveLength(2);
  });

  it('refuses a real mode without a key and certificate', async () => {
    await reachOhipStep();
    await userEvent.selectOptions(screen.getByLabelText('Mode'), 'production');

    await userEvent.click(screen.getByRole('button', { name: /finish setup/i }));

    expect(await screen.findByText(/private key and certificate are both required/i)).toBeInTheDocument();
    expect(api.markOnboarded).not.toHaveBeenCalled();
  });

  it('saves ministry credentials and finishes', async () => {
    api.saveOhipSettings.mockResolvedValue({ success: true, mode: 'conformance' });
    const onComplete = await reachOhipStep();

    await userEvent.selectOptions(screen.getByLabelText('Mode'), 'conformance');
    await userEvent.type(screen.getByLabelText(/private key path/i), '/keys/ohip-key.pem');
    await userEvent.type(screen.getByLabelText(/certificate path/i), '/keys/ohip-cert.pem');
    await userEvent.type(screen.getByLabelText(/go secure username/i), 'dr-smith');
    await userEvent.type(screen.getByLabelText(/go secure password/i), 'secret');
    await userEvent.type(screen.getByLabelText(/moh id/i), '123456');
    await userEvent.type(screen.getByLabelText(/conformance key/i), 'key-abc');

    await userEvent.click(screen.getByRole('button', { name: /finish setup/i }));

    expect(api.saveOhipSettings).toHaveBeenCalledWith({
      mode: 'conformance',
      privateKeyPath: '/keys/ohip-key.pem',
      certificatePath: '/keys/ohip-cert.pem',
      username: 'dr-smith',
      password: 'secret',
      mohId: '123456',
      conformanceKey: 'key-abc',
    });
    expect(api.markOnboarded).toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalled();
  });
});
