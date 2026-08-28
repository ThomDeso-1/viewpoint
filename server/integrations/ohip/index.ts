import type { HcvClient } from './hcv-client.js';
import type { HcvMode } from '../../exams/types.js';
import { MockHcvClient } from './hcv-mock.js';
import { SoapHcvClient, loadConfigFromEnv } from './hcv-soap.js';

/**
 * Chooses the HCV backend.
 *
 * Defaults to the mock, deliberately: reaching the real service requires
 * ministry conformance testing and an issued production key, so an
 * unconfigured install must degrade to something obviously fake rather
 * than fail or, worse, appear to work.
 */

export * from './hcv-client.js';
export { MockHcvClient } from './hcv-mock.js';
export { SoapHcvClient, loadConfigFromEnv } from './hcv-soap.js';

export function hcvMode(): HcvMode {
  const mode = process.env.OHIP_HCV_MODE;
  return mode === 'conformance' || mode === 'production' ? mode : 'mock';
}

let cached: { mode: HcvMode; client: HcvClient } | null = null;

export function getHcvClient(): HcvClient {
  const mode = hcvMode();

  if (cached?.mode === mode) return cached.client;

  const client: HcvClient = mode === 'mock' ? new MockHcvClient() : new SoapHcvClient(loadConfigFromEnv());

  cached = { mode, client };
  return client;
}

/** Test seam, and used when credentials change at runtime. */
export function resetHcvClient(): void {
  cached = null;
}
