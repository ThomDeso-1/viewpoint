import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MicrosoftSettings } from '../../src/exams/MicrosoftSettings';
import { ToastProvider } from '../../src/shared/Toast';
import type { MicrosoftStatus } from '../../src/shared/api';

vi.mock('../../src/shared/api');
import * as api from '../../src/shared/api';

function status(overrides: Partial<MicrosoftStatus> = {}): MicrosoftStatus {
  return {
    configured: false,
    connected: false,
    redirectUri: 'http://localhost:3000/api/microsoft/callback',
    accountLabel: null,
    scope: null,
    expiresAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  for (const fn of Object.values(api)) (fn as any).mockReset?.();
  api.getMicrosoftStatus.mockResolvedValue(status());
  api.saveMicrosoftCredentials.mockResolvedValue({ success: true, redirectUri: status().redirectUri });
  api.disconnectMicrosoft.mockResolvedValue({ success: true });
});

function renderPanel() {
  return render(
    <ToastProvider>
      <MicrosoftSettings />
    </ToastProvider>,
  );
}

describe('MicrosoftSettings', () => {
  it('shows the redirect URI and a client-id form when not configured', async () => {
    renderPanel();
    expect(await screen.findByText('http://localhost:3000/api/microsoft/callback')).toBeInTheDocument();
    expect(screen.getByText('Not signed in')).toBeInTheDocument();
    expect(screen.queryByLabelText(/client secret/i)).not.toBeInTheDocument();
  });

  it('saves a client id without a secret', async () => {
    renderPanel();
    await userEvent.type(await screen.findByLabelText(/Application \(client\) ID/i), 'app-id');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));

    expect(api.saveMicrosoftCredentials).toHaveBeenCalledWith({
      clientId: 'app-id',
      tenant: undefined,
    });
  });

  it('offers Sign in once configured, and Disconnect once connected', async () => {
    api.getMicrosoftStatus.mockResolvedValue(status({ configured: true }));
    renderPanel();
    expect(await screen.findByRole('link', { name: /sign in with microsoft/i })).toHaveAttribute(
      'href',
      '/api/microsoft/connect',
    );

    api.getMicrosoftStatus.mockResolvedValue(
      status({ configured: true, connected: true, accountLabel: 'reception@example.com' }),
    );
    renderPanel();
    expect(await screen.findByText(/reception@example.com/)).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: /disconnect/i })[0]);
    await waitFor(() => expect(api.disconnectMicrosoft).toHaveBeenCalled());
  });
});
