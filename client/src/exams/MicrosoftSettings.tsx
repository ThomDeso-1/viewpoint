import { useEffect, useState } from 'react';
import {
  getMicrosoftStatus,
  saveMicrosoftCredentials,
  disconnectMicrosoft,
  type MicrosoftStatus,
} from '../shared/api';
import { useToast } from '../shared/Toast';

/**
 * Microsoft / Outlook connection panel for the Settings page.
 *
 * Mirrors GoogleSettings: the consent flow is a full-page redirect, so
 * "Connect" is a plain link. It must be started from a browser on the
 * machine running the server — the redirect URI is a localhost address.
 */
export function MicrosoftSettings() {
  const [status, setStatus] = useState<MicrosoftStatus | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [tenant, setTenant] = useState('');
  const [saving, setSaving] = useState(false);
  const { showToast } = useToast();

  const load = async () => {
    try {
      setStatus(await getMicrosoftStatus());
    } catch {
      setStatus(null);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveMicrosoftCredentials({ clientId, clientSecret, tenant: tenant || undefined });
      setClientSecret('');
      showToast('Saved. You can connect now.', 'success');
      await load();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDisconnect = async () => {
    try {
      await disconnectMicrosoft();
      showToast('Outlook disconnected.', 'success');
      await load();
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  };

  return (
    <section className="settings-section">
      <h2 className="settings-section-title">Outlook / Microsoft 365</h2>

      <p className="settings-help">
        An alternative to Gmail for sending appointment reminder emails from your mailbox.
        Choose which one to use under “Reminder email account” below.
      </p>

      <div className="settings-row">
        <span className="settings-label">Status</span>
        <span className="settings-value">
          {status?.connected ? (
            <>Connected{status.accountLabel ? ` — ${status.accountLabel}` : ''}</>
          ) : (
            <span className="settings-not-set">Not connected</span>
          )}
        </span>
      </div>

      {!status?.configured && (
        <>
          <p className="muted" style={{ margin: '8px 0' }}>
            Register an app in Azure (App registrations, type: Web) with the Microsoft Graph
            <code> Mail.Send</code> permission, and add this redirect URI:
          </p>
          <code className="preview-block">{status?.redirectUri ?? '/api/microsoft/callback'}</code>

          <label className="wizard-field-label">
            Application (client) ID
            <input
              className="auth-input"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              autoComplete="off"
            />
          </label>
          <label className="wizard-field-label">
            Client secret
            <input
              className="auth-input"
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              autoComplete="off"
            />
          </label>
          <label className="wizard-field-label">
            Directory (tenant) ID — optional
            <input
              className="auth-input"
              value={tenant}
              onChange={(e) => setTenant(e.target.value)}
              placeholder="common"
              autoComplete="off"
            />
          </label>
          <button
            className="btn-primary"
            onClick={handleSave}
            disabled={saving || !clientId || !clientSecret}
          >
            {saving ? 'Saving…' : 'Save credentials'}
          </button>
        </>
      )}

      {status?.configured && !status.connected && (
        <>
          <a className="btn-primary" href="/api/microsoft/connect">
            Connect Outlook
          </a>
          <p className="muted" style={{ marginTop: 8 }}>
            Do this from a browser on the computer running the app.
          </p>
        </>
      )}

      {status?.connected && (
        <button className="btn-secondary" onClick={handleDisconnect}>
          Disconnect
        </button>
      )}
    </section>
  );
}
