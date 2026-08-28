import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { setupTestApp, type TestContext } from '../helpers/testApp.js';

/**
 * OHIP eligibility: the mock backend's scenarios, the SOAP envelope's
 * shape and signature, and the service that joins a check to a patient
 * record without ever persisting the health card number again.
 */

describe('mock HCV client', () => {
  let ctx: TestContext;
  let ohip: typeof import('../../server/integrations/ohip/index.js');

  beforeEach(async () => {
    ctx = await setupTestApp();
    ohip = await import('../../server/integrations/ohip/index.js');
  });
  afterEach(() => ctx.teardown());

  it('is the default when no mode is configured', () => {
    expect(ohip.hcvMode()).toBe('mock');
    expect(ohip.getHcvClient()).toBeInstanceOf(ohip.MockHcvClient);
  });

  it('reports a valid card as eligible', async () => {
    const result = await new ohip.MockHcvClient().checkEligibility({ healthCardNumber: '1111111111' });

    expect(result.isEligible).toBe(true);
    expect(result.responseCode).toBe('50');
    expect(result.mode).toBe('mock');
  });

  it('stamps every result as mock so it cannot pass for a real one', async () => {
    const result = await new ohip.MockHcvClient().checkEligibility({ healthCardNumber: '2222222222' });
    expect(result.mode).toBe('mock');
    expect(JSON.parse(result.raw).mock).toBe(true);
  });

  it.each([
    ['2222222222', '52', 'expired'],
    ['3333333333', '54', 'invalid number'],
    ['4444444444', '65', 'not eligible'],
    ['5555555555', '55', 'lost or stolen'],
    ['6666666666', '51', 'wrong version code'],
  ])('reports %s as ineligible (%s — %s)', async (number, code) => {
    const result = await new ohip.MockHcvClient().checkEligibility({ healthCardNumber: number });
    expect(result.isEligible).toBe(false);
    expect(result.responseCode).toBe(code);
  });

  it('raises a retryable error for the service-unavailable scenario', async () => {
    await expect(
      new ohip.MockHcvClient().checkEligibility({ healthCardNumber: '9999999999' }),
    ).rejects.toMatchObject({ code: 'server_error', isRetryable: true });
  });

  it('rejects a malformed health card number without calling out', async () => {
    await expect(
      new ohip.MockHcvClient().checkEligibility({ healthCardNumber: '123' }),
    ).rejects.toMatchObject({ code: 'invalid_request', isRetryable: false });
  });

  it('rejects a malformed version code', async () => {
    await expect(
      new ohip.MockHcvClient().checkEligibility({ healthCardNumber: '1111111111', versionCode: 'XYZ' }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('describes an unknown response code without claiming eligibility', () => {
    const described = ohip.describeResponseCode('99');
    expect(described.eligible).toBe(false);
    expect(described.description).toContain('99');
  });
});

describe('SOAP envelope construction', () => {
  let ctx: TestContext;
  let soap: typeof import('../../server/integrations/ohip/hcv-soap.js');
  let config: import('../../server/integrations/ohip/hcv-soap.js').HcvSoapConfig;

  beforeEach(async () => {
    ctx = await setupTestApp();
    soap = await import('../../server/integrations/ohip/hcv-soap.js');

    // A throwaway self-signed key pair, so the signing path is exercised
    // for real rather than stubbed.
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const certLike = publicKey.export({ type: 'spki', format: 'pem' }).toString();

    config = {
      mode: 'conformance',
      endpoint: 'https://example.invalid/HCVService',
      privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      certificatePem: certLike,
      username: 'test-user',
      password: 'test-pass',
      mohId: '123456',
      conformanceKey: 'conformance-key-abc',
    };
  });
  afterEach(() => ctx.teardown());

  function envelope() {
    return new soap.SoapHcvClient(config).buildSignedEnvelope({
      healthCardNumber: '1234567890',
      versionCode: 'ab',
      dateOfService: '2026-09-01',
    });
  }

  it('produces a signature over both the Timestamp and the Body', () => {
    const xml = envelope();

    expect(xml).toContain('<ds:Signature');
    expect(xml).toContain('ds:SignatureValue');
    // Two references — one per signed element.
    expect(xml.match(/<ds:Reference/g)?.length).toBe(2);
    expect(xml).toContain('URI="#Timestamp"');
    expect(xml).toContain('URI="#Body"');
  });

  it('carries the certificate as a BinarySecurityToken', () => {
    const xml = envelope();

    expect(xml).toContain('wsse:BinarySecurityToken');
    expect(xml).toContain('wsu:Id="X509Token"');
    // Bare base64 DER, with the PEM armour stripped.
    expect(xml).not.toContain('BEGIN PUBLIC KEY');
  });

  it('references the token from KeyInfo rather than inlining the certificate twice', () => {
    const xml = envelope();

    expect(xml).toContain('SecurityTokenReference');
    expect(xml).toContain('URI="#X509Token"');
  });

  it('uses exclusive canonicalisation, as WS-Security requires', () => {
    expect(envelope()).toContain('http://www.w3.org/2001/10/xml-exc-c14n#');
  });

  it('includes the request details and the conformance key', () => {
    const xml = envelope();

    expect(xml).toContain('<ebs:HealthNumber>1234567890</ebs:HealthNumber>');
    expect(xml).toContain('<ebs:VersionCode>AB</ebs:VersionCode>'); // upper-cased
    expect(xml).toContain('<ebs:FeeServiceDate>2026-09-01</ebs:FeeServiceDate>');
    expect(xml).toContain('conformance-key-abc');
    expect(xml).toContain('<ebs:MOHId>123456</ebs:MOHId>');
  });

  it('stamps a Timestamp that expires in the future', () => {
    const xml = envelope();

    const created = /<wsu:Created>([^<]+)<\/wsu:Created>/.exec(xml)![1];
    const expires = /<wsu:Expires>([^<]+)<\/wsu:Expires>/.exec(xml)![1];

    expect(new Date(expires).getTime()).toBeGreaterThan(new Date(created).getTime());
  });

  it('escapes credentials that contain XML metacharacters', () => {
    config.password = 'pa<ss&word';
    const xml = new soap.SoapHcvClient(config).buildSignedEnvelope({ healthCardNumber: '1234567890' });

    expect(xml).toContain('pa&lt;ss&amp;word');
    expect(xml).not.toContain('pa<ss&word');
  });

  it('refuses a malformed card number before building anything', async () => {
    await expect(
      new soap.SoapHcvClient(config).checkEligibility({ healthCardNumber: 'not-a-number' }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  describe('response parsing', () => {
    const client = () => new soap.SoapHcvClient(config);

    it('reads the response code regardless of namespace prefix', () => {
      const result = client().parseResponse(
        `<soap:Envelope><soap:Body><ns2:HCVResponse>
           <ns2:ResponseCode>50</ns2:ResponseCode>
           <ns2:FirstName>Ada</ns2:FirstName>
           <ns2:LastName>Lovelace</ns2:LastName>
         </ns2:HCVResponse></soap:Body></soap:Envelope>`,
      );

      expect(result.isEligible).toBe(true);
      expect(result.responseCode).toBe('50');
      expect(result.firstName).toBe('Ada');
      expect(result.lastName).toBe('Lovelace');
      expect(result.mode).toBe('conformance');
    });

    it('reports an ineligible code as a result, not an error', () => {
      const result = client().parseResponse(`<Envelope><ResponseCode>52</ResponseCode></Envelope>`);

      expect(result.isEligible).toBe(false);
      expect(result.responseCode).toBe('52');
      expect(result.responseDescription).toContain('expired');
    });

    it('turns a SOAP fault into an error', () => {
      expect(() =>
        client().parseResponse(
          `<soap:Envelope><soap:Body><soap:Fault>
             <faultstring>Invalid conformance key</faultstring>
           </soap:Fault></soap:Body></soap:Envelope>`,
        ),
      ).toThrow(/Invalid conformance key/);
    });

    it('rejects a response with no response code', () => {
      expect(() => client().parseResponse('<Envelope><Body/></Envelope>')).toThrow(/no response code/i);
    });
  });

  it('requires credentials before it can be configured from the environment', () => {
    expect(() => soap.loadConfigFromEnv()).toThrow(/not set/);
  });
});

describe('eligibility service', () => {
  let ctx: TestContext;
  let eligibility: typeof import('../../server/practice/eligibility.js');
  let patients: typeof import('../../server/practice/patients.js');

  beforeEach(async () => {
    ctx = await setupTestApp();
    eligibility = await import('../../server/practice/eligibility.js');
    patients = await import('../../server/practice/patients.js');
  });
  afterEach(() => ctx.teardown());

  function rawChecks() {
    const db = new Database(path.join(ctx.dataDir, 'receipts.db'), { readonly: true });
    const rows = db.prepare(`SELECT * FROM eligibility_checks`).all() as Record<string, unknown>[];
    db.close();
    return rows;
  }

  it('records an eligible result against the patient', async () => {
    const p = patients.createPatient({ full_name: 'Ada', health_card_number: '1111111111' });

    const outcome = await eligibility.checkPatientEligibility({ patientId: p.id });

    expect(outcome.isEligible).toBe(true);
    expect(outcome.responseCode).toBe('50');
    expect(outcome.error).toBeNull();
    expect(eligibility.latestCheckForPatient(p.id)?.is_eligible).toBe(1);
  });

  it('never writes the health card number back to the check row', async () => {
    const p = patients.createPatient({ full_name: 'Ada', health_card_number: '1111111111' });

    await eligibility.checkPatientEligibility({ patientId: p.id });

    expect(JSON.stringify(rawChecks())).not.toContain('1111111111');
  });

  it('encrypts the ministry response at rest', async () => {
    const p = patients.createPatient({ full_name: 'Ada', health_card_number: '1111111111' });
    await eligibility.checkPatientEligibility({ patientId: p.id });

    const row = rawChecks()[0];
    expect(String(row.raw_response_enc).startsWith('v1:')).toBe(true);
  });

  it('records an ineligible verdict as a result rather than an error', async () => {
    const p = patients.createPatient({ full_name: 'Bob', health_card_number: '2222222222' });

    const outcome = await eligibility.checkPatientEligibility({ patientId: p.id });

    expect(outcome.isEligible).toBe(false);
    expect(outcome.error).toBeNull();
    expect(outcome.responseCode).toBe('52');
  });

  it('records a service outage as an error with no verdict', async () => {
    const p = patients.createPatient({ full_name: 'Carol', health_card_number: '9999999999' });

    const outcome = await eligibility.checkPatientEligibility({ patientId: p.id });

    expect(outcome.isEligible).toBeNull();
    expect(outcome.error).toContain('unavailable');
  });

  it('reuses a recent successful check instead of re-querying the ministry (P1-5)', async () => {
    const p = patients.createPatient({ full_name: 'Ada', health_card_number: '1111111111' });

    const first = await eligibility.checkPatientEligibility({ patientId: p.id });
    expect(first.reused).toBeUndefined();

    const second = await eligibility.checkPatientEligibility({ patientId: p.id });
    expect(second.reused).toBe(true);
    expect(second.checkId).toBe(first.checkId);
    expect(rawChecks()).toHaveLength(1); // no second row, no second disclosure
  });

  it('force re-queries even inside the reuse window', async () => {
    const p = patients.createPatient({ full_name: 'Ada', health_card_number: '1111111111' });

    await eligibility.checkPatientEligibility({ patientId: p.id });
    const forced = await eligibility.checkPatientEligibility({ patientId: p.id, force: true });

    expect(forced.reused).toBeUndefined();
    expect(rawChecks()).toHaveLength(2);
  });

  it('does not reuse a failed check', async () => {
    const p = patients.createPatient({ full_name: 'Carol', health_card_number: '9999999999' });

    await eligibility.checkPatientEligibility({ patientId: p.id });
    const second = await eligibility.checkPatientEligibility({ patientId: p.id });

    expect(second.reused).toBeUndefined();
    expect(rawChecks()).toHaveLength(2);
  });

  it('reports a missing health card without calling the service', async () => {
    const p = patients.createPatient({ full_name: 'Dave' });

    const outcome = await eligibility.checkPatientEligibility({ patientId: p.id });

    expect(outcome.isEligible).toBeNull();
    expect(outcome.error).toContain('No health card number');
  });

  it('handles an unknown patient', async () => {
    const outcome = await eligibility.checkPatientEligibility({ patientId: 'does-not-exist' });
    expect(outcome.error).toContain('Patient not found');
  });

  it('audits the check and the card decryption', async () => {
    const p = patients.createPatient({ full_name: 'Ada', health_card_number: '1111111111' });
    await eligibility.checkPatientEligibility({ patientId: p.id });

    const db = new Database(path.join(ctx.dataDir, 'receipts.db'), { readonly: true });
    const actions = (db.prepare(`SELECT action FROM audit_log`).all() as { action: string }[]).map(
      (r) => r.action,
    );
    db.close();

    expect(actions).toContain('health_card.decrypt');
    expect(actions).toContain('eligibility.check');
  });

  it('keeps a history, newest first', async () => {
    const p = patients.createPatient({ full_name: 'Ada', health_card_number: '1111111111' });

    await eligibility.checkPatientEligibility({ patientId: p.id, dateOfService: '2026-09-01' });
    await eligibility.checkPatientEligibility({ patientId: p.id, dateOfService: '2026-09-02' });

    const history = eligibility.checksForPatient(p.id);
    expect(history).toHaveLength(2);
    expect(history[0].date_of_service).toBe('2026-09-02');
  });

  it('omits the encrypted response from the API representation', async () => {
    const p = patients.createPatient({ full_name: 'Ada', health_card_number: '1111111111' });
    await eligibility.checkPatientEligibility({ patientId: p.id });

    const dto = eligibility.toEligibilityDto(eligibility.latestCheckForPatient(p.id)!);

    expect(dto).not.toHaveProperty('raw_response_enc');
    expect(dto.is_eligible).toBe(true);
    expect(dto.mode).toBe('mock');
  });
});
