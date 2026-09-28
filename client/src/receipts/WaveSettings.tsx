import { useState, type FormEvent } from 'react';
import {
  validateWaveToken,
  saveWaveConnection,
  saveWaveSalesTax,
  getWaveTaxes,
  type Settings as SettingsData,
} from '../shared/api';
import { useToast } from '../shared/Toast';
import { Button } from '../ui/Button';
import { Field, Select, TextField } from '../ui/Field';
import { Notice } from '../ui/Notice';
import { KeyValueList, KeyValue } from '../ui/KeyValue';

interface Props {
  settings: SettingsData | null;
  waveHealthy: boolean | null;
  onSaved: () => void;
}

interface WaveBusiness {
  id: string;
  name: string;
  isPersonal: boolean;
}

interface WaveTax {
  id: string;
  name: string;
  rate: number;
}

type Stage = 'idle' | 'token' | 'business' | 'tax';

/**
 * Wave Accounting panel for the Settings page.
 *
 * Runs the same token → business → accounts flow as the onboarding
 * wizard, so a user who skipped that step can connect Wave later without
 * hand-editing `.env`.
 */
export function WaveSettings({ settings, waveHealthy, onSaved }: Props) {
  const [stage, setStage] = useState<Stage>('idle');
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [businesses, setBusinesses] = useState<WaveBusiness[]>([]);
  const [taxes, setTaxes] = useState<WaveTax[]>([]);
  const [salesTaxId, setSalesTaxId] = useState('');
  const { showToast } = useToast();

  const reset = () => {
    setStage('idle');
    setToken('');
    setError('');
    setBusinesses([]);
    setTaxes([]);
    setSalesTaxId('');
  };

  const handleTokenSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!token.trim()) return;

    setBusy(true);
    try {
      const result = await validateWaveToken(token.trim());
      if (!result.valid) {
        setError(result.error || 'That token could not be validated.');
        return;
      }
      setBusinesses(result.businesses || []);
      setStage('business');
    } catch (err) {
      setError((err as Error).message || 'Could not validate the token.');
    } finally {
      setBusy(false);
    }
  };

  const handleSelectBusiness = async (business: WaveBusiness) => {
    setError('');
    setBusy(true);
    try {
      await saveWaveConnection({
        token: token.trim(),
        businessId: business.id,
        businessName: business.name,
      });
      setTaxes(await getWaveTaxes());
      setStage('tax');
    } catch (err) {
      setError((err as Error).message || 'Could not load sales taxes for that business.');
    } finally {
      setBusy(false);
    }
  };

  const handleTaxSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await saveWaveSalesTax(salesTaxId);
      showToast('Wave connected.', 'success');
      reset();
      onSaved();
    } catch (err) {
      setError((err as Error).message || 'Could not save Wave settings.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="vp-subpanel">
      <h3 className="vp-subpanel-title">Wave Accounting</h3>

      <KeyValueList>
        <KeyValue label="Access token">
          {settings?.hasWaveToken ? (
            <span className="vp-mono">{settings.waveTokenPreview}</span>
          ) : (
            <span className="vp-muted">Not configured</span>
          )}
        </KeyValue>
        <KeyValue label="Connection">
          {waveHealthy === null ? (
            '…'
          ) : waveHealthy ? (
            <span className="vp-ok-text">Connected</span>
          ) : (
            <span className="vp-error-text">Disconnected</span>
          )}
        </KeyValue>
        {settings?.waveBusinessName && (
          <KeyValue label="Business">{settings.waveBusinessName}</KeyValue>
        )}
      </KeyValueList>

      {stage === 'idle' && (
        <Button variant="ghost" size="sm" onClick={() => setStage('token')}>
          {settings?.hasWaveToken ? 'Reconnect Wave' : 'Connect Wave'}
        </Button>
      )}

      {stage === 'token' && (
        <form onSubmit={handleTokenSubmit} className="vp-subpanel-form">
          <TextField
            label="Access token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Wave access token"
            autoComplete="off"
            autoFocus
            error={error || undefined}
            help={
              <>
                Create a full-access token at <code>developer.waveapps.com</code> under Manage
                Applications. Used to send exam invoices.
              </>
            }
          />
          <div className="vp-form-actions">
            <Button type="submit" variant="primary" loading={busy} disabled={!token.trim()}>
              Connect
            </Button>
            <Button type="button" variant="secondary" onClick={reset} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {stage === 'business' && (
        <div className="vp-subpanel-form">
          <p className="vp-subpanel-lede">Which Wave business should invoices come from?</p>
          {error && <Notice tone="danger">{error}</Notice>}
          <div className="vp-choice-list">
            {businesses.map((b) => (
              <button
                key={b.id}
                type="button"
                className="vp-choice"
                onClick={() => handleSelectBusiness(b)}
                disabled={busy}
              >
                <span>{b.name}</span>
                {b.isPersonal && <span className="vp-muted">Personal</span>}
              </button>
            ))}
          </div>
          <Button variant="ghost" size="sm" onClick={() => setStage('token')} disabled={busy}>
            ← Back
          </Button>
        </div>
      )}

      {stage === 'tax' && (
        <form onSubmit={handleTaxSubmit} className="vp-subpanel-form">
          <Field label="Sales tax on invoices (optional)" htmlFor="wave-sales-tax">
            <Select
              id="wave-sales-tax"
              value={salesTaxId}
              onChange={(e) => setSalesTaxId(e.target.value)}
            >
              <option value="">None</option>
              {taxes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} ({(t.rate * 100).toFixed(1)}%)
                </option>
              ))}
            </Select>
          </Field>

          {error && <Notice tone="danger">{error}</Notice>}
          <div className="vp-form-actions">
            <Button type="submit" variant="primary" loading={busy}>
              Save
            </Button>
            <Button type="button" variant="secondary" onClick={() => setStage('business')} disabled={busy}>
              ← Back
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
