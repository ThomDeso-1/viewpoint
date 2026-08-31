import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OhipSettings } from '../../src/exams/OhipSettings';
import { ToastProvider } from '../../src/shared/Toast';
import type { OhipSettings as Data } from '../../src/shared/api';

vi.mock('../../src/shared/api');
import * as api from '../../src/shared/api';

function settings(overrides: Partial<Data> = {}): Data {
  return {
    mode: 'mock',
    privateKeyPath: '',
    certificatePath: '',
    caCertPath: '',
    hasPrivateKey: false,
    hasCertificate: false,
    hasCaCert: false,
    username: '',
    mohId: '',
    hasPassword: false,
    hasConformanceKey: false,
    endpoint: '',
    ...overrides,
  };
}

beforeEach(() => {
  for (const fn of Object.values(api)) (fn as any).mockReset?.();
  api.getOhipSettings.mockResolvedValue(settings());
  api.saveOhipSettings.mockResolvedValue({ success: true, mode: 'mock' });
});

function renderPanel() {
  return render(
    <ToastProvider>
      <OhipSettings />
    </ToastProvider>,
  );
}

/**
 * Spec: mock mode must be visibly distinct from real validation — a
 * simulated result that looks real is the worst outcome here. Secrets are
 * write-only: the server never returns them.
 */
describe('OhipSettings', () => {
  it('flags mock mode as simulated and lists the test numbers', async () => {
    renderPanel();

    expect(await screen.findByText('Simulated')).toBeInTheDocument();
    expect(screen.getByText('1111111111')).toBeInTheDocument();
    expect(screen.getByText('9999999999')).toBeInTheDocument();
  });

  it('hides ministry credential fields while in mock mode', async () => {
    renderPanel();
    await screen.findByText('Simulated');

    expect(screen.queryByLabelText('Private key')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /test connection/i })).not.toBeInTheDocument();
  });

  it('reveals credential fields once a real mode is chosen', async () => {
    renderPanel();
    await screen.findByText('Simulated');

    await userEvent.selectOptions(screen.getByLabelText(/Validation mode/i), 'conformance');

    expect(screen.getByLabelText('Private key')).toBeInTheDocument();
    expect(screen.getByLabelText('Private key file')).toBeInTheDocument();
    expect(screen.getByLabelText(/go secure username/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/conformance key/i)).toBeInTheDocument();
  });

  it('sends a pasted PEM and stores it server-side', async () => {
    api.getOhipSettings.mockResolvedValue(settings({ mode: 'conformance' }));
    renderPanel();
    await screen.findByText('conformance');

    await userEvent.type(screen.getByLabelText('Certificate'), '-----BEGIN CERTIFICATE-----abc');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.saveOhipSettings).toHaveBeenCalled());
    const payload = api.saveOhipSettings.mock.calls[0][0];
    expect(payload.certificatePem).toContain('BEGIN CERTIFICATE');
    expect(payload).not.toHaveProperty('privateKeyPem');
  });

  it('marks an already-stored PEM without echoing it', async () => {
    api.getOhipSettings.mockResolvedValue(settings({ mode: 'conformance', hasCertificate: true }));
    renderPanel();
    await screen.findByText('conformance');

    expect(screen.getByText('— stored')).toBeInTheDocument();
    expect(screen.getByLabelText('Certificate')).toHaveValue('');
  });

  it('names the key field for the mode chosen', async () => {
    renderPanel();
    await screen.findByText('Simulated');

    await userEvent.selectOptions(screen.getByLabelText(/Validation mode/i), 'production');
    expect(screen.getByLabelText(/production key/i)).toBeInTheDocument();
  });

  it('shows the openssl conversion on request', async () => {
    renderPanel();
    await screen.findByText('Simulated');
    await userEvent.selectOptions(screen.getByLabelText(/Validation mode/i), 'conformance');

    await userEvent.click(screen.getByRole('button', { name: /show certificate setup/i }));
    expect(screen.getByText(/openssl pkcs12/)).toBeInTheDocument();
  });

  it('marks stored secrets as unchanged rather than echoing them', async () => {
    api.getOhipSettings.mockResolvedValue(
      settings({ mode: 'conformance', hasPassword: true, hasConformanceKey: true }),
    );
    renderPanel();

    await screen.findByText('conformance');
    expect(screen.getAllByPlaceholderText(/unchanged/i).length).toBeGreaterThan(0);
  });

  it('omits blank secret fields when saving, so stored ones survive', async () => {
    api.getOhipSettings.mockResolvedValue(
      settings({ mode: 'conformance', hasPassword: true, username: 'dr-smith' }),
    );
    renderPanel();
    await screen.findByText('conformance');

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.saveOhipSettings).toHaveBeenCalled());
    const payload = api.saveOhipSettings.mock.calls[0][0];
    expect(payload).not.toHaveProperty('password');
    expect(payload.username).toBe('dr-smith');
  });

  it('sends a newly typed secret', async () => {
    api.getOhipSettings.mockResolvedValue(settings({ mode: 'conformance' }));
    renderPanel();
    await screen.findByText('conformance');

    await userEvent.type(screen.getByLabelText(/go secure password/i), 'hunter2');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.saveOhipSettings).toHaveBeenCalled());
    expect(api.saveOhipSettings.mock.calls[0][0].password).toBe('hunter2');
  });

  it('reports a configuration test result', async () => {
    api.getOhipSettings.mockResolvedValue(settings({ mode: 'conformance' }));
    api.testOhipConnection.mockResolvedValue({
      ok: true,
      checked: 'configuration',
      message: 'Credentials load and a signed request builds.',
    });
    renderPanel();
    await screen.findByText('conformance');

    await userEvent.click(screen.getByRole('button', { name: /test connection/i }));

    expect(await screen.findByText(/signed request builds/i)).toBeInTheDocument();
  });

  it('reports a failed test rather than staying silent', async () => {
    api.getOhipSettings.mockResolvedValue(settings({ mode: 'conformance' }));
    api.testOhipConnection.mockRejectedValue(new Error('OHIP_PRIVATE_KEY_PATH is not set.'));
    renderPanel();
    await screen.findByText('conformance');

    await userEvent.click(screen.getByRole('button', { name: /test connection/i }));

    expect(await screen.findByText(/OHIP_PRIVATE_KEY_PATH is not set/i)).toBeInTheDocument();
  });
});
