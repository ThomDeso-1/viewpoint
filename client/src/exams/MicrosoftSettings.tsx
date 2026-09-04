import { useEffect, useState } from 'react';
import {
  getMicrosoftStatus,
  saveMicrosoftCredentials,
  disconnectMicrosoft,
  type MicrosoftStatus,
} from '../shared/api';
import { useToast } from '../shared/Toast';

/**
 * Microsoft / Outlook sign-in panel for the Settings page.
 *
 * One sign-in grants identity, sending mail, and calendar access. The
 * flow is a full-page redirect, so "Sign in" is a plain link; it must be
 * started from a browser on the machine running the server, because the
 * redirect URI is a localhost address.
 *
 * The app ships with its own application (client) ID, so the ID form only
 * appears when a deployment hasn't been given one.
 */
export function MicrosoftSettings() {
  const [status, setStatus] = useState<MicrosoftStatus | null>(null);
  const [clientId, setClientId] = useState('');
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
      await saveMicrosoftCredentials({ clientId: clientId.trim(), tenant: tenant.trim() || undefined });
      showToast('Saved. You can sign in now.', 'success');
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
        Sign in once to send appointment reminders from your mailbox and keep the Schedule in sync
        with your Outlook calendar. The app never reads your inbox.
      </p>

      <div className="settings-row">
        <span className="settings-label">Status</span>
        <span className="settings-value">
          {status?.connected ? (
            <>Signed in{status.accountLabel ? ` — ${status.accountLabel}` : ''}</>
          ) : (
            <span className="settings-not-set">Not signed in</span>
          )}
        </span>
      </div>

      {!status?.configured && (
        <>
          <p className="muted" style={{ margin: '8px 0' }}>
            Register an app in Azure (App registrations, platform: <em>Mobile &amp; desktop
            applications</em>), turn on <em>Allow public client flows</em>, add this redirect URI, and
            grant the Microsoft Graph <code>Calendars.ReadWrite</code> and <code>Mail.Send</code>{' '}
            delegated permissions. No client secret is needed.
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
            Directory (tenant) ID — optional
            <input
              className="auth-input"
              value={tenant}
              onChange={(e) => setTenant(e.target.value)}
              placeholder="common"
              autoComplete="off"
            />
          </label>
          <button className="btn-primary" onClick={handleSave} disabled={saving || !clientId.trim()}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      )}

      {status?.configured && !status.connected && (
        <>
          <a className="btn-primary" href="/api/microsoft/connect" target="_blank" rel="noopener">
            Sign in with Microsoft
          </a>
          <p className="muted" style={{ marginTop: 8 }}>
            Opens in a new tab. Use a work or school account, not a personal outlook.com one — a
            personal account's sign-in expires every 24 hours instead of every 90 days.
          </p>
        </>
      )}

      {status?.connected && (
        <div className="request-actions">
          <a className="btn-secondary" href="/api/microsoft/connect" target="_blank" rel="noopener">
            Reconnect
          </a>
          <button className="btn-secondary" onClick={handleDisconnect}>
            Disconnect
          </button>
        </div>
      )}
    </section>
  );
}
