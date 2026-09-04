import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Onboarding } from '../../src/auth/Onboarding';

vi.mock('../../src/shared/api');
import * as api from '../../src/shared/api';

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.getMicrosoftStatus.mockResolvedValue({
    configured: true,
    connected: false,
    redirectUri: 'http://localhost:3000/api/microsoft/callback',
    accountLabel: null,
    scope: null,
    expiresAt: null,
  });
});

function renderWizard(onComplete = vi.fn(), ohipEnabled = true) {
  render(
    <MemoryRouter>
      <Onboarding onComplete={onComplete} ohipEnabled={ohipEnabled} />
    </MemoryRouter>,
  );
  return onComplete;
}

/**
 * Spec: a short first-run wizard — password (done before this mounts),
 * Claude API key, Wave (token → business), Outlook / Microsoft 365, then
 * OHIP. Every credential step can be skipped. The finer Wave account
 * setup, the full Microsoft app-registration form, and OHIP ministry
 * credentials moved to Settings; finishing always records OHIP `mock`
 * explicitly so results stay labelled simulated.
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

  it('selecting a business saves the connection and hands off to the Microsoft step', async () => {
    api.validateWaveToken.mockResolvedValue({
      valid: true,
      businesses: [{ id: 'b1', name: 'Acme Co', isPersonal: false }],
    });
    api.saveWaveConnection.mockResolvedValue({ success: true });
    api.markOnboarded.mockResolvedValue({ success: true });

    await skipToWave();
    await userEvent.type(screen.getByPlaceholderText('Wave access token'), 'wave-token');
    await userEvent.click(screen.getByRole('button', { name: /^connect$/i }));
    await userEvent.click(await screen.findByText('Acme Co'));

    expect(api.saveWaveConnection).toHaveBeenCalledWith({
      token: 'wave-token',
      businessId: 'b1',
      businessName: 'Acme Co',
    });

    await screen.findByText(/connect outlook/i);
    expect(api.markOnboarded).not.toHaveBeenCalled();
  });

  it('skipping Wave advances to the Microsoft step', async () => {
    const onComplete = vi.fn();
    renderWizard(onComplete);

    await userEvent.click(screen.getByRole('button', { name: /skip for now/i }));
    await screen.findByText(/connect wave/i);
    await userEvent.click(screen.getByRole('button', { name: /skip for now/i }));

    await screen.findByText(/connect outlook/i);
    expect(api.saveWaveConnection).not.toHaveBeenCalled();
    expect(api.markOnboarded).not.toHaveBeenCalled();
  });
});

describe('Onboarding: Microsoft step', () => {
  async function skipToMicrosoft(onComplete = vi.fn()) {
    renderWizard(onComplete);
    await userEvent.click(screen.getByRole('button', { name: /skip for now/i }));
    await screen.findByText(/connect wave/i);
    await userEvent.click(screen.getByRole('button', { name: /skip for now/i }));
    await screen.findByText(/connect outlook/i);
    return onComplete;
  }

  it('shows a sign-in link that opens in a new tab and warns off personal accounts', async () => {
    await skipToMicrosoft();

    const link = screen.getByRole('link', { name: /sign in with microsoft/i });
    expect(link).toHaveAttribute('href', '/api/microsoft/connect');
    expect(link).toHaveAttribute('target', '_blank');
    expect(screen.getByText(/personal outlook\.com account/i)).toBeInTheDocument();
  });

  it('skipping Microsoft advances to the OHIP step without connecting anything', async () => {
    await skipToMicrosoft();
    await userEvent.click(screen.getByRole('button', { name: /skip for now/i }));

    await screen.findByText(/ohip validation/i);
    expect(api.markOnboarded).not.toHaveBeenCalled();
  });

  it('shows Continue instead of the sign-in link once already connected', async () => {
    api.getMicrosoftStatus.mockResolvedValue({
      configured: true,
      connected: true,
      redirectUri: 'http://localhost:3000/api/microsoft/callback',
      accountLabel: 'ada@clinic.example',
      scope: 'Calendars.ReadWrite',
      expiresAt: null,
    });
    await skipToMicrosoft();

    expect(await screen.findByText(/ada@clinic\.example/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /sign in with microsoft/i })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    await screen.findByText(/ohip validation/i);
  });
});

describe('Onboarding: OHIP disabled (default)', () => {
  it('skips the OHIP step entirely and finishes after Microsoft', async () => {
    const onComplete = vi.fn();
    api.markOnboarded.mockResolvedValue({ success: true });
    renderWizard(onComplete, false);

    await userEvent.click(screen.getByRole('button', { name: /skip for now/i }));
    await screen.findByText(/connect wave/i);
    // Step count reflects four steps, not five.
    expect(screen.getByText(/step 3 of 4/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /skip for now/i }));
    await screen.findByText(/connect outlook/i);
    expect(screen.getByText(/step 4 of 4/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /skip for now/i }));

    expect(screen.queryByText(/ohip validation/i)).not.toBeInTheDocument();
    expect(api.saveOhipSettings).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(api.markOnboarded).toHaveBeenCalled());
    expect(onComplete).toHaveBeenCalled();
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
    await screen.findByText(/connect outlook/i);
    await userEvent.click(screen.getByRole('button', { name: /skip for now/i }));
    await screen.findByText(/ohip validation/i);
    return onComplete;
  }

  it('explains that validation starts simulated and points real setup to Settings', async () => {
    await reachOhipStep();

    expect(screen.getByText(/starts in/i)).toBeInTheDocument();
    expect(screen.getByText(/Settings → OHIP/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Mode')).not.toBeInTheDocument();
  });

  it('finishing records mock explicitly, marks onboarding complete, and calls onComplete', async () => {
    const onComplete = await reachOhipStep();

    await userEvent.click(screen.getByRole('button', { name: /finish setup/i }));

    expect(api.saveOhipSettings).toHaveBeenCalledWith({ mode: 'mock' });
    expect(api.markOnboarded).toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalled();
  });
});
