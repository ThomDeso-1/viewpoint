import type { HcvClient, EligibilityRequest, EligibilityResult } from './hcv-client.js';
import { describeResponseCode, validateHealthCardFormat, HcvError } from './hcv-client.js';

/**
 * A deterministic stand-in for the ministry service.
 *
 * This is what runs until conformance testing is complete and a
 * production key is issued — which is a months-long process — so the rest
 * of the workflow can be built, demonstrated, and tested end to end in
 * the meantime.
 *
 * Every result is stamped `mode: 'mock'` so a fabricated eligibility
 * answer can never be mistaken for a real one, in the database or the UI.
 */

/** Numbers reserved to exercise each branch. Anything else validates. */
const SCENARIOS: Record<string, string> = {
  '1111111111': '50', // valid
  '2222222222': '52', // expired
  '3333333333': '54', // invalid number
  '4444444444': '65', // not eligible
  '5555555555': '55', // reported lost or stolen
  '6666666666': '51', // wrong version code
  '9999999999': 'ERROR', // simulates the service being unavailable
};

export class MockHcvClient implements HcvClient {
  async checkEligibility(request: EligibilityRequest): Promise<EligibilityResult> {
    const formatError = validateHealthCardFormat(request);
    if (formatError) {
      throw new HcvError('invalid_request', formatError);
    }

    const number = request.healthCardNumber.replace(/[\s-]/g, '');
    const scenario = SCENARIOS[number] ?? '50';

    if (scenario === 'ERROR') {
      throw new HcvError('server_error', 'The ministry validation service is unavailable.');
    }

    const { eligible, description } = describeResponseCode(scenario);

    return {
      isEligible: eligible,
      responseCode: scenario,
      responseDescription: description,
      firstName: eligible ? 'Test' : null,
      lastName: eligible ? 'Patient' : null,
      expiryDate: eligible ? '2030-01-01' : null,
      mode: 'mock',
      raw: JSON.stringify({
        mock: true,
        healthNumberSuffix: number.slice(-4),
        versionCode: request.versionCode ?? null,
        dateOfService: request.dateOfService ?? null,
        responseCode: scenario,
      }),
    };
  }
}
