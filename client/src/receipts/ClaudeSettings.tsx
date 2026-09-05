import { useState, type FormEvent } from 'react';
import { validateClaudeKey, saveClaudeKey, type Settings as SettingsData } from '../shared/api';
import { useToast } from '../shared/Toast';
import { Button } from '../ui/Button';
import { TextField } from '../ui/Field';
import { Notice } from '../ui/Notice';
import { KeyValueList, KeyValue } from '../ui/KeyValue';

interface Props {
  settings: SettingsData | null;
  onSaved: () => void;
}

/**
 * Claude API key panel. The same validate-then-save the onboarding wizard
 * runs, so a user who skipped that step can add the key later.
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
    <section className="vp-subpanel">
      <h3 className="vp-subpanel-title">Claude API</h3>

      <KeyValueList>
        <KeyValue label="API key">
          {settings?.hasClaudeKey ? (
            <span className="vp-mono">{settings.claudeKeyPreview}</span>
          ) : (
            <span className="vp-muted">Not configured</span>
          )}
        </KeyValue>
      </KeyValueList>

      {!editing ? (
        <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
          {settings?.hasClaudeKey ? 'Replace key' : 'Add key'}
        </Button>
      ) : (
        <form onSubmit={handleSubmit} className="vp-subpanel-form">
          <TextField
            label="API key"
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="sk-ant-…"
            autoComplete="off"
            autoFocus
            help={
              <>
                Create one at <code>console.anthropic.com</code> under API keys. Used to read vendor,
                date and totals off your receipt photos.
              </>
            }
          />
          {error && <Notice tone="danger">{error}</Notice>}
          <div className="vp-form-actions">
            <Button type="submit" variant="primary" loading={saving} disabled={!key.trim()}>
              Validate &amp; Save
            </Button>
            <Button type="button" variant="secondary" onClick={cancel} disabled={saving}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
