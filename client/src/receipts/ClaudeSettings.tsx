import { useState, type FormEvent } from 'react';
import { validateClaudeKey, saveClaudeKey, type Settings as SettingsData } from '../shared/api';
import { useToast } from '../shared/Toast';

interface Props {
  settings: SettingsData | null;
  onSaved: () => void;
}

/**
 * Claude API key panel for the Settings page.
 *
 * The same validate-then-save the onboarding wizard runs, so a user who
 * skipped that step can add the key later without editing `.env` by hand.
 */
export function ClaudeSettings({ settings, onSaved }: Props) {
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const { showToast } = useToast();

  const cancel = () => {
    setEditing(false);
    setKey('');
    setError('');
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!key.trim()) return;

    setSaving(true);
    try {
      const result = await validateClaudeKey(key.trim());
      if (!result.valid) {
        setError(result.error || 'That key could not be validated.');
        return;
      }
      await saveClaudeKey(key.trim());
      showToast('Claude API key saved.', 'success');
      cancel();
      onSaved();
    } catch (err) {
      setError((err as Error).message || 'Could not validate the key.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-section">
      <h2 className="settings-section-title">Claude API</h2>
      <div className="settings-row">
        <span className="settings-label">API Key</span>
        <span className="settings-value">
          {settings?.hasClaudeKey ? (
            <span className="settings-key-preview">{settings.claudeKeyPreview}</span>
          ) : (
            <span className="settings-not-set">Not configured</span>
          )}
        </span>
      </div>

      {!editing ? (
        <button className="link-button" onClick={() => setEditing(true)}>
          {settings?.hasClaudeKey ? 'Replace key' : 'Add key'}
        </button>
      ) : (
        <form onSubmit={handleSubmit}>
          <label className="wizard-field-label" htmlFor="claude-key">
            API key
          </label>
          <input
            id="claude-key"
            className="auth-input"
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="sk-ant-…"
            autoComplete="off"
            autoFocus
          />
          <p className="settings-help">
            Create one at <code>console.anthropic.com</code> under API keys. Used to read vendor, date,
            and totals off your receipt photos.
          </p>
          {error && <p className="auth-error">{error}</p>}
          <div className="request-actions">
            <button type="submit" className="btn-primary" disabled={saving || !key.trim()}>
              {saving ? 'Validating…' : 'Validate & Save'}
            </button>
            <button type="button" className="btn-secondary" onClick={cancel} disabled={saving}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
