import { useEffect, useState } from 'react';
import { getOhipSettings, saveOhipSettings, testOhipConnection, type OhipSettings as Data } from '../api/client';
import { useToast } from './Toast';

/**
 * OHIP Health Card Validation configuration.
 *
 * Mode is the important control: `mock` returns simulated results, which
 * are labelled as such everywhere they appear. Only switch to conformance
 * or production once the ministry has issued credentials, because a
 * result that looks real but isn't is the worst outcome here.
 */
export function OhipSettings() {
  const [data, setData] = useState<Data | null>(null);
  const [form, setForm] = useState({
    mode: 'mock' as Data['mode'],
    privateKeyPath: '',
    certificatePath: '',
    caCertPath: '',
    username: '',
    mohId: '',
    endpoint: '',
  });
  const [password, setPassword] = useState('');
  const [conformanceKey, setConformanceKey] = useState('');
  const [testCard, setTestCard] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const { showToast } = useToast();

  const load = async () => {
    try {
      const settings = await getOhipSettings();
      setData(settings);
      setForm({
        mode: settings.mode,
        privateKeyPath: settings.privateKeyPath,
        certificatePath: settings.certificatePath,
        caCertPath: settings.caCertPath,
        username: settings.username,
        mohId: settings.mohId,
        endpoint: settings.endpoint,
      });
    } catch {
      setData(null);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      // Blank secret fields mean "leave what's stored alone" — the server
      // never sends them back, so they always render empty.
      await saveOhipSettings({
        ...form,
        ...(password ? { password } : {}),
        ...(conformanceKey ? { conformanceKey } : {}),
      });
      setPassword('');
      setConformanceKey('');
      showToast('OHIP settings saved.', 'success');
      await load();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      const result = await testOhipConnection(testCard ? { healthCardNumber: testCard } : {});
      if (result.checked === 'live') {
        showToast(
          result.isEligible
            ? `Valid — ${result.responseDescription ?? result.responseCode}`
            : `Not covered (${result.responseCode}) — ${result.responseDescription ?? ''}`,
          result.isEligible ? 'success' : 'error',
        );
      } else {
        showToast(result.message ?? 'Configuration looks good.', 'success');
      }
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setTesting(false);
    }
  };

  const isMock = form.mode === 'mock';

  return (
    <section className="settings-section">
      <h2 className="settings-section-title">OHIP Health Card Validation</h2>

      <div className="settings-row">
        <span className="settings-label">Mode</span>
        <span className="settings-value">
          {data?.mode === 'mock' ? (
            <span className="settings-unhealthy">Simulated</span>
          ) : (
            <span className="settings-healthy">{data?.mode}</span>
          )}
        </span>
      </div>

      <label className="wizard-field-label" htmlFor="ohip-mode">
        Validation mode
      </label>
      <select
        id="ohip-mode"
        className="wizard-select"
        value={form.mode}
        onChange={(e) => setForm({ ...form, mode: e.target.value as Data['mode'] })}
      >
        <option value="mock">Mock — simulated results, no ministry contact</option>
        <option value="conformance">Conformance — ministry test environment</option>
        <option value="production">Production — live ministry service</option>
      </select>

      {isMock ? (
        <p className="settings-help">
          Results are simulated and clearly labelled <strong>mock</strong> throughout the app. Use the
          test numbers below to exercise each outcome:
          <br />
          <code>1111111111</code> valid · <code>2222222222</code> expired ·{' '}
          <code>3333333333</code> invalid · <code>4444444444</code> not eligible ·{' '}
          <code>5555555555</code> lost/stolen · <code>9999999999</code> service down
        </p>
      ) : (
        <>
          <p className="settings-help">
            Requires ministry credentials: an OHIP billing number, a GO Secure ID with the{' '}
            <strong>Health Service HCV</strong> role, and the conformance (or production) key issued
            after conformance testing.
          </p>

          <button className="link-button" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Hide' : 'Show'} certificate setup instructions
          </button>

          {expanded && (
            <div className="settings-instructions">
              <p>
                Node cannot read a <code>.p12</code> keystore directly, so convert yours to PEM once
                and point the fields below at the results:
              </p>
              <pre className="preview-block">{`openssl pkcs12 -in yourStore.p12 -nocerts -nodes \\
  -out ohip-key.pem
openssl pkcs12 -in yourStore.p12 -clcerts -nokeys \\
  -out ohip-cert.pem`}</pre>
              <p>
                Keep both files outside the app folder, readable only by you (
                <code>chmod 600</code>). Enter absolute paths.
              </p>
            </div>
          )}

          <label className="wizard-field-label">
            Private key path
            <input
              className="auth-input"
              value={form.privateKeyPath}
              onChange={(e) => setForm({ ...form, privateKeyPath: e.target.value })}
              placeholder="/Users/you/ohip/ohip-key.pem"
            />
          </label>

          <label className="wizard-field-label">
            Certificate path
            <input
              className="auth-input"
              value={form.certificatePath}
              onChange={(e) => setForm({ ...form, certificatePath: e.target.value })}
              placeholder="/Users/you/ohip/ohip-cert.pem"
            />
          </label>

          <label className="wizard-field-label">
            CA bundle path (optional)
            <input
              className="auth-input"
              value={form.caCertPath}
              onChange={(e) => setForm({ ...form, caCertPath: e.target.value })}
              placeholder="/Users/you/ohip/cacert.pem"
            />
          </label>

          <label className="wizard-field-label">
            GO Secure username
            <input
              className="auth-input"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              autoComplete="off"
            />
          </label>

          <label className="wizard-field-label">
            GO Secure password
            <input
              className="auth-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={data?.hasPassword ? '•••••••• (unchanged)' : ''}
              autoComplete="off"
            />
          </label>

          <label className="wizard-field-label">
            MOH ID / billing number
            <input
              className="auth-input"
              value={form.mohId}
              onChange={(e) => setForm({ ...form, mohId: e.target.value })}
              autoComplete="off"
            />
          </label>

          <label className="wizard-field-label">
            {form.mode === 'production' ? 'Production key' : 'Conformance key'}
            <input
              className="auth-input"
              type="password"
              value={conformanceKey}
              onChange={(e) => setConformanceKey(e.target.value)}
              placeholder={data?.hasConformanceKey ? '•••••••• (unchanged)' : ''}
              autoComplete="off"
            />
          </label>

          <label className="wizard-field-label">
            Endpoint override (optional)
            <input
              className="auth-input"
              value={form.endpoint}
              onChange={(e) => setForm({ ...form, endpoint: e.target.value })}
              placeholder="Leave blank to use the standard ministry endpoint"
            />
          </label>
        </>
      )}

      <div className="request-actions">
        <button className="btn-primary" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {!isMock && data?.mode !== 'mock' && (
          <button className="btn-secondary" onClick={handleTest} disabled={testing}>
            {testing ? 'Testing…' : 'Test connection'}
          </button>
        )}
      </div>

      {!isMock && data?.mode !== 'mock' && (
        <label className="wizard-field-label">
          Test with a health number (optional)
          <input
            className="auth-input"
            value={testCard}
            onChange={(e) => setTestCard(e.target.value)}
            placeholder="Leave blank to check credentials only"
            inputMode="numeric"
          />
          <small className="muted">
            Blank verifies your certificate and key without contacting the ministry. A number runs a
            real validation.
          </small>
        </label>
      )}
    </section>
  );
}
