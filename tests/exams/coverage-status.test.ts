import { describe, it, expect, afterEach } from 'vitest';
import { classifyCoverageStatus } from '../../server/exams/coverage-status.js';
import { ohipEnabled } from '../../server/integrations/ohip/index.js';

describe('classifyCoverageStatus', () => {
  const cases: [string | null, ReturnType<typeof classifyCoverageStatus>][] = [
    ['Eligible', 'covered'],
    ['OK', 'covered'],
    ['Elig. 12/05/24', 'covered'],
    ['covered', 'covered'],
    ['Not eligible', 'not_covered'],
    ['not elig', 'not_covered'],
    ['card expired', 'not_covered'],
    ['No OHIP', 'not_covered'],
    ['$180 private pay', 'private_pay'],
    ['private pay', 'private_pay'],
    ['$140', 'private_pay'],
    ['407', 'unknown'],
    ['', 'unknown'],
    [null, 'unknown'],
    ['  ', 'unknown'],
  ];

  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${expected}`, () => {
      expect(classifyCoverageStatus(input)).toBe(expected);
    });
  }

  it('checks "not eligible" before "eligible" so it is not misread as covered', () => {
    expect(classifyCoverageStatus('patient not eligible')).toBe('not_covered');
  });
});

describe('ohipEnabled', () => {
  const original = process.env.OHIP_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.OHIP_ENABLED;
    else process.env.OHIP_ENABLED = original;
  });

  it('is off unless explicitly set to "true"', () => {
    delete process.env.OHIP_ENABLED;
    expect(ohipEnabled()).toBe(false);
    process.env.OHIP_ENABLED = 'false';
    expect(ohipEnabled()).toBe(false);
    process.env.OHIP_ENABLED = '1';
    expect(ohipEnabled()).toBe(false);
    process.env.OHIP_ENABLED = 'true';
    expect(ohipEnabled()).toBe(true);
  });
});
