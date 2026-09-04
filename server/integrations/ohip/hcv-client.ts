/**
 * Ontario Health Card Validation (HCV) — the interface the rest of the
 * app depends on.
 *
 * Nothing outside this directory should know whether a result came from
 * the ministry's SOAP service or from the mock: the queue, the routes,
 * and the UI all speak only in terms of EligibilityResult.
 */

import type { HcvMode } from '../../exams/types.js';
import { ApiError } from '../../platform/api-error.js';

export interface EligibilityRequest {
  /** 10-digit Ontario health number, digits only. */
  healthCardNumber: string;
  /** 2-letter version code. Optional — some cards predate version codes. */
  versionCode?: string | null;
  /** "YYYY-MM-DD". Defaults to today. */
  dateOfService?: string;
}

export interface EligibilityResult {
  isEligible: boolean;
  /** Ministry response code, verbatim. */
  responseCode: string;
  responseDescription: string;
  /** Returned by the ministry on a successful match; used to confirm identity. */
  firstName: string | null;
  lastName: string | null;
  expiryDate: string | null;
  /** Which backend produced this — a mock result must never look real. */
  mode: HcvMode;
  /** Full response for the audit trail. Stored encrypted. */
  raw: string;
}

export interface HcvClient {
  checkEligibility(request: EligibilityRequest): Promise<EligibilityResult>;
}

/**
 * Transport and ministry-side outages (`isRetryable`, inherited) are
 * worth retrying; a rejected card or a misconfigured keystore is not.
 */
export class HcvError extends ApiError {
  constructor(code: string, message: string) {
    super('HcvError', code, message);
  }
}

/**
 * Ministry response codes.
 *
 * The authoritative table is in the MOH technical specification —
 * "Technical Specification for Health Card Validation via Electronic
 * Business Services" — not in any third-party example. These entries
 * cover the outcomes the workflow branches on; verify and extend them
 * against the current spec before going live, which is also when the
 * conformance test suite will exercise them.
 */
export const RESPONSE_CODES: Record<string, { eligible: boolean; description: string }> = {
  '50': { eligible: true, description: 'Health card is valid.' },
  '51': { eligible: false, description: 'Health number is valid but the version code is wrong.' },
  '52': { eligible: false, description: 'Health card has expired.' },
  '53': { eligible: false, description: 'Health number is registered to a deceased person.' },
  '54': { eligible: false, description: 'Health number is not valid.' },
  '55': { eligible: false, description: 'Health card was reported lost or stolen.' },
  '65': { eligible: false, description: 'Person is not currently eligible for OHIP coverage.' },
};

export function describeResponseCode(code: string): { eligible: boolean; description: string } {
  return (
    RESPONSE_CODES[code] ?? {
      eligible: false,
      description: `Ministry returned an unrecognised response code (${code}).`,
    }
  );
}

/** Ontario health numbers are exactly 10 digits; version codes are 2 letters. */
export function validateHealthCardFormat(request: EligibilityRequest): string | null {
  const number = request.healthCardNumber?.replace(/[\s-]/g, '') ?? '';

  if (!/^\d{10}$/.test(number)) {
    return 'A health card number must be exactly 10 digits.';
  }

  if (request.versionCode && !/^[A-Za-z]{2}$/.test(request.versionCode)) {
    return 'A version code must be exactly 2 letters.';
  }

  return null;
}
