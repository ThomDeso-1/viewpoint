import { useEffect, useState } from 'react';
import {
  getMicrosoftStatus,
  saveMicrosoftCredentials,
  disconnectMicrosoft,
  type MicrosoftStatus,
} from '../shared/api';
import { useToast } from '../shared/Toast';
import { Button } from '../ui/Button';
import { TextField } from '../ui/Field';
import { KeyValueList, KeyValue } from '../ui/KeyValue';

/**
 * Microsoft / Outlook sign-in panel. One sign-in grants identity, sending
 * mail, and calendar access. The flow is a full-page redirect started from
 * a browser on the machine running the server (the redirect URI is a
 * localhost address). The app ships its own client ID, so the ID form only
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
    <section className="vp-subpanel">
      <h3 className="vp-subpanel-title">Outlook / Microsoft 365</h3>
      <p className="vp-subpanel-lede">
        Sign in once to send appointment reminders from your mailbox and keep the Schedule in sync
        with your Outlook calendar. The app never reads your inbox.
      </p>

      <KeyValueList>
        <KeyValue label="Status">
          {status?.connected ? (
            <>Signed in{status.accountLabel ? ` — ${status.accountLabel}` : ''}</>
          ) : (
            <span className="vp-muted">Not signed in</span>
          )}
        </KeyValue>
      </KeyValueList>

      {!status?.configured && (
        <div className="vp-subpanel-form">
          <p className="vp-subpanel-lede">
            Register an app in Azure (App registrations, platform: <em>Mobile &amp; desktop
            applications</em>), turn on <em>Allow public client flows</em>, add this redirect URI, and
            grant the Microsoft Graph <code>Calendars.ReadWrite</code> and <code>Mail.Send</code>{' '}
            delegated permissions. No client secret is needed.
          </p>
          <pre className="vp-preview">{status?.redirectUri ?? '/api/microsoft/callback'}</pre>

          <TextField
            label="Application (client) ID"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            autoComplete="off"
          />
          <TextField
            label="Directory (tenant) ID — optional"
            value={tenant}
            onChange={(e) => setTenant(e.target.value)}
            placeholder="common"
            autoComplete="off"
          />
          <Button variant="primary" onClick={handleSave} loading={saving} disabled={!clientId.trim()}>
            Save
          </Button>
        </div>
      )}

      {status?.configured && !status.connected && (
        <div className="vp-subpanel-form">
          <Button variant="primary" href="/api/microsoft/connect" target="_blank" rel="noopener">
            Sign in with Microsoft
          </Button>
          <p className="vp-subpanel-lede">
            Opens in a new tab. Use a work or school account, not a personal outlook.com one — a
            personal account's sign-in expires every 24 hours instead of every 90 days.
          </p>
        </div>
      )}

      {status?.connected && (
        <div className="vp-form-actions">
          <Button variant="secondary" href="/api/microsoft/connect" target="_blank" rel="noopener">
            Reconnect
          </Button>
          <Button variant="secondary" onClick={handleDisconnect}>
            Disconnect
          </Button>
        </div>
      )}
    </section>
  );
}
