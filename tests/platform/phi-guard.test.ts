import { describe, it, expect, afterEach } from 'vitest';
import { setupTestApp, type TestContext } from '../helpers/testApp.js';

/**
 * P0-2: the server refuses to serve personal health information over
 * plain HTTP unless the operator explicitly overrides it.
 */

describe('PHI start-guard', () => {
  let ctx: TestContext;

  afterEach(() => ctx?.teardown());

  async function guard() {
    const mod = await import('../../server/platform/phi-guard.js');
    return mod.assertSafeForPhi;
  }

  it('allows a fresh install (no patients, mock OHIP, plain HTTP)', async () => {
    ctx = await setupTestApp();
    expect(await guard()).not.toThrow();
  });

  it('refuses to start once a patient record exists', async () => {
    ctx = await setupTestApp();
    const patients = await import('../../server/practice/patients.js');
    patients.createPatient({ full_name: 'Ada' });

    await expect(guard().then((fn) => fn())).rejects.toThrow(/plain HTTP/i);
  });

  it('refuses to start when OHIP is not in mock mode', async () => {
    ctx = await setupTestApp({ OHIP_HCV_MODE: 'conformance' });
    await expect(guard().then((fn) => fn())).rejects.toThrow(/OHIP_HCV_MODE/);
  });

  it('allows an explicit ALLOW_INSECURE_PHI override', async () => {
    ctx = await setupTestApp({ ALLOW_INSECURE_PHI: '1' });
    const patients = await import('../../server/practice/patients.js');
    patients.createPatient({ full_name: 'Ada' });
    expect(await guard()).not.toThrow();
  });

  it('allows an HTTPS public URL', async () => {
    ctx = await setupTestApp({ APP_PUBLIC_URL: 'https://clinic.example' });
    const patients = await import('../../server/practice/patients.js');
    patients.createPatient({ full_name: 'Ada' });
    expect(await guard()).not.toThrow();
  });

  it('allows it when a reverse proxy is declared (TRUST_PROXY=1)', async () => {
    ctx = await setupTestApp({ TRUST_PROXY: '1', OHIP_HCV_MODE: 'conformance' });
    expect(await guard()).not.toThrow();
  });

  it('never blocks demo mode', async () => {
    ctx = await setupTestApp({ DEMO_MODE: '1', OHIP_HCV_MODE: 'conformance' });
    const patients = await import('../../server/practice/patients.js');
    patients.createPatient({ full_name: 'Ada' });
    expect(await guard()).not.toThrow();
  });
});
