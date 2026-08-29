import { getDb } from '../db/db.js';
import { hcvMode } from '../integrations/ohip/index.js';
import { isDemoMode } from './endpoints.js';

/**
 * Refuses to start over plain HTTP once real patient data is in play.
 *
 * The app is commonly run on a plain-HTTP LAN. That was fine for expense
 * receipts; it is not fine once the database holds health card numbers,
 * or once eligibility checks are hitting the real ministry service. This
 * guard makes the operator make an explicit choice rather than leaking
 * PHI across the wire by default.
 *
 * Called from index.ts only — tests build the app directly and never
 * reach this.
 */

/** True when the deployment is (or claims to be) reachable over HTTPS. */
function isHttpsConfigured(): boolean {
  const httpsUrl = (v?: string) => !!v && v.startsWith('https://');
  return (
    httpsUrl(process.env.APP_PUBLIC_URL) ||
    httpsUrl(process.env.GOOGLE_REDIRECT_URI) ||
    httpsUrl(process.env.WAVE_REDIRECT_URI) ||
    process.env.TRUST_PROXY === '1' // a proxy is in front — assume it terminates TLS
  );
}

function patientCount(): number {
  try {
    const row = getDb().prepare(`SELECT COUNT(*) AS n FROM patients`).get() as { n: number };
    return row.n;
  } catch {
    // Table may not exist yet on a fresh install — no PHI, no problem.
    return 0;
  }
}

export function assertSafeForPhi(): void {
  if (isDemoMode()) return;
  if (isHttpsConfigured()) return;

  const liveOhip = hcvMode() !== 'mock';
  const patients = patientCount();
  if (!liveOhip && patients === 0) return;

  const reason = liveOhip
    ? `OHIP_HCV_MODE is "${hcvMode()}" — real health card numbers cross the network`
    : `the database holds ${patients} patient record(s)`;

  if (process.env.ALLOW_INSECURE_PHI === '1') {
    console.warn('');
    console.warn('  ┌─────────────────────────────────────────────────────────────┐');
    console.warn('  │  INSECURE: serving personal health information over plain    │');
    console.warn('  │  HTTP. ALLOW_INSECURE_PHI=1 is set, so startup continues.    │');
    console.warn(`  │  Reason: ${reason.padEnd(50)}│`);
    console.warn('  │  Set up HTTPS (docs/DEPLOYMENT.md) and remove this override. │');
    console.warn('  └─────────────────────────────────────────────────────────────┘');
    console.warn('');
    return;
  }

  throw new Error(
    `Refusing to start over plain HTTP: ${reason}.\n` +
      `  Set up HTTPS (see docs/DEPLOYMENT.md and deploy/Caddyfile) and set one of\n` +
      `  APP_PUBLIC_URL=https://... , TRUST_PROXY=1 , or an https redirect URI.\n` +
      `  To run insecure anyway (LAN testing only, not with real patients), set\n` +
      `  ALLOW_INSECURE_PHI=1 .`,
  );
}
