import { useEffect, useState } from 'react';
import { getGoogleStatus, saveGoogleCredentials, disconnectGoogle, type GoogleStatus } from '../shared/api';
import { useToast } from '../shared/Toast';

/**
 * Google connection panel for the Settings page.
 *
 * The consent flow is a full-page redirect to Google, so "Connect" is a
 * plain link rather than a fetch. It must be started from a browser on
 * the machine running the server: the redirect URI is a localhost
 * address, which only resolves there.
 */
export function GoogleSettings() {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const { showToast } = useToast();

  const load = async () => {
    try {
      setStatus(await getGoogleStatus());
    } catch {
      // Settings should still render if this one panel can't load.
      setStatus(null);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      await saveGoogleCredentials({ clientId, clientSecret });
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
      await disconnectGoogle();
      showToast('Google disconnected.', 'success');
      await load();
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  };

  return (
    <section className="settings-section">
      <h2 className="settings-section-title">Google (Gmail &amp; Calendar)</h2>

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
            Create an OAuth client in Google Cloud Console (type: Web application) and add this
            redirect URI:
          </p>
          <code className="preview-block">{status?.redirectUri ?? '/api/google/callback'}</code>

          <label className="wizard-field-label">
            Client ID
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
          {/* A real navigation, not fetch: the OAuth consent screen has to
              own the tab. */}
          <a className="btn-primary" href="/api/google/connect">
            Connect Google
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
