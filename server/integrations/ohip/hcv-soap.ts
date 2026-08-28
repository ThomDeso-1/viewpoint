import fs from 'fs';
import crypto from 'crypto';
import { SignedXml } from 'xml-crypto';
import type { HcvClient, EligibilityRequest, EligibilityResult } from './hcv-client.js';
import { describeResponseCode, validateHealthCardFormat, HcvError } from './hcv-client.js';
import type { HcvMode } from '../../practice/types.js';
import { escapeXml } from '../../platform/escape.js';

/**
 * The real Health Card Validation client — a TypeScript port of the PHP
 * example at https://github.com/mykiBoy/OHIP-HCV.
 *
 * The ministry's service is SOAP with WS-Security: the request carries an
 * X.509 BinarySecurityToken and an XML-DSig signature over the Timestamp
 * and Body elements. Getting that signature byte-exact is the whole
 * difficulty, and it is what this file exists to do.
 *
 * ── What is verified and what is not ────────────────────────────────────
 * The security header, canonicalisation, and signing below follow the
 * WS-Security X.509 profile and are standard. The *message schema* — the
 * element and namespace names inside the Body, and the EBS header fields
 * — must be confirmed against the ministry's own document,
 * "Technical Specification for Health Card Validation via Electronic
 * Business Services", and against the WSDL issued with your conformance
 * credentials. They are collected in ELEMENTS below so a correction is a
 * one-line change rather than a rewrite.
 *
 * You cannot reach the production service without completing MOH
 * conformance testing, so treat everything here as unproven until that
 * suite passes. Until then the app runs MockHcvClient.
 *
 * ── Keys ────────────────────────────────────────────────────────────────
 * Node has no PKCS#12 reader, so this takes PEM rather than the .p12 the
 * PHP example loads. Convert once:
 *
 *   openssl pkcs12 -in testStore.p12 -nocerts -nodes -out ohip-key.pem
 *   openssl pkcs12 -in testStore.p12 -clcerts -nokeys -out ohip-cert.pem
 */

const CONFORMANCE_ENDPOINT = 'https://ws.conf.ebs.health.gov.on.ca:1443/HCVService/HCVService';
const PRODUCTION_ENDPOINT = 'https://ws.ebs.health.gov.on.ca:1443/HCVService/HCVService';

const NS = {
  soap: 'http://schemas.xmlsoap.org/soap/envelope/',
  wsse: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd',
  wsu: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd',
};

const X509_TOKEN_TYPE =
  'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-x509-token-profile-1.0#X509v3';
const BASE64_ENCODING =
  'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary';

/**
 * Ministry-specific names, isolated so they can be corrected against the
 * spec without touching the signing code.
 */
const ELEMENTS = {
  serviceNamespace: 'http://ebs.health.gov.on.ca/',
  operation: 'validate',
  requestElement: 'HCVRequest',
  auditIdElement: 'AuditId',
  soapAction: 'validate',
};

export interface HcvSoapConfig {
  mode: HcvMode;
  endpoint: string;
  privateKeyPem: string;
  certificatePem: string;
  username: string;
  password: string;
  mohId: string;
  /** Conformance key during testing; production key once approved. */
  conformanceKey: string;
  /** Optional CA bundle — cacert.pem ships with the PHP example. */
  caCertPem?: string;
}

export function loadConfigFromEnv(): HcvSoapConfig {
  const mode: HcvMode = process.env.OHIP_HCV_MODE === 'production' ? 'production' : 'conformance';

  const required = (name: string): string => {
    const value = process.env[name];
    if (!value) {
      throw new HcvError(
        'not_configured',
        `${name} is not set. OHIP validation needs your ministry credentials — see docs/SETUP-CREDENTIALS.md.`,
      );
    }
    return value;
  };

  const readFile = (name: string): string => {
    const filePath = required(name);
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      throw new HcvError('not_configured', `Could not read ${name} at ${filePath}: ${(err as Error).message}`);
    }
  };

  return {
    mode,
    endpoint:
      process.env.OHIP_ENDPOINT ||
      (mode === 'production' ? PRODUCTION_ENDPOINT : CONFORMANCE_ENDPOINT),
    privateKeyPem: readFile('OHIP_PRIVATE_KEY_PATH'),
    certificatePem: readFile('OHIP_CERTIFICATE_PATH'),
    username: required('OHIP_USERNAME'),
    password: required('OHIP_PASSWORD'),
    mohId: required('OHIP_MOH_ID'),
    conformanceKey: required('OHIP_CONFORMANCE_KEY'),
    caCertPem: process.env.OHIP_CA_CERT_PATH
      ? fs.readFileSync(process.env.OHIP_CA_CERT_PATH, 'utf-8')
      : undefined,
  };
}

/** Strips PEM armour to the bare base64 DER the token carries. */
export function pemToBase64Der(pem: string): string {
  return pem
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
}

export class SoapHcvClient implements HcvClient {
  constructor(private config: HcvSoapConfig) {}

  async checkEligibility(request: EligibilityRequest): Promise<EligibilityResult> {
    const formatError = validateHealthCardFormat(request);
    if (formatError) {
      throw new HcvError('invalid_request', formatError);
    }

    const envelope = this.buildSignedEnvelope(request);
    const responseXml = await this.post(envelope);

    return this.parseResponse(responseXml);
  }

  /**
   * Builds the envelope and signs the Timestamp and Body.
   *
   * The two elements carry `wsu:Id` attributes so the signature can
   * reference them; xml-crypto has to be told about `wsu:Id` explicitly
   * because it only recognises Id/ID/id by default.
   */
  buildSignedEnvelope(request: EligibilityRequest): string {
    const now = new Date();
    const created = now.toISOString();
    const expires = new Date(now.getTime() + 5 * 60 * 1000).toISOString();

    const certBase64 = pemToBase64Der(this.config.certificatePem);
    const auditId = crypto.randomUUID();

    const healthNumber = request.healthCardNumber.replace(/[\s-]/g, '');
    const versionCode = request.versionCode ? request.versionCode.toUpperCase() : '';
    const dateOfService = request.dateOfService || new Date().toISOString().slice(0, 10);

    const unsigned = `<?xml version="1.0" encoding="UTF-8"?>
<soap:Envelope xmlns:soap="${NS.soap}" xmlns:ebs="${ELEMENTS.serviceNamespace}">
  <soap:Header>
    <wsse:Security xmlns:wsse="${NS.wsse}" xmlns:wsu="${NS.wsu}" soap:mustUnderstand="1">
      <wsse:BinarySecurityToken EncodingType="${BASE64_ENCODING}" ValueType="${X509_TOKEN_TYPE}" wsu:Id="X509Token">${certBase64}</wsse:BinarySecurityToken>
      <wsu:Timestamp wsu:Id="Timestamp">
        <wsu:Created>${created}</wsu:Created>
        <wsu:Expires>${expires}</wsu:Expires>
      </wsu:Timestamp>
      <wsse:UsernameToken wsu:Id="UsernameToken">
        <wsse:Username>${escapeXml(this.config.username)}</wsse:Username>
        <wsse:Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText">${escapeXml(this.config.password)}</wsse:Password>
      </wsse:UsernameToken>
    </wsse:Security>
    <ebs:EBS>
      <ebs:SoftwareConformanceKey>${escapeXml(this.config.conformanceKey)}</ebs:SoftwareConformanceKey>
      <ebs:AuditId>${auditId}</ebs:AuditId>
    </ebs:EBS>
  </soap:Header>
  <soap:Body xmlns:wsu="${NS.wsu}" wsu:Id="Body">
    <ebs:${ELEMENTS.operation}>
      <ebs:${ELEMENTS.requestElement}>
        <ebs:MOHId>${escapeXml(this.config.mohId)}</ebs:MOHId>
        <ebs:HealthNumber>${healthNumber}</ebs:HealthNumber>
        <ebs:VersionCode>${versionCode}</ebs:VersionCode>
        <ebs:FeeServiceDate>${dateOfService}</ebs:FeeServiceDate>
      </ebs:${ELEMENTS.requestElement}>
    </ebs:${ELEMENTS.operation}>
  </soap:Body>
</soap:Envelope>`;

    const sig = new SignedXml({
      privateKey: this.config.privateKeyPem,
      signatureAlgorithm: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
      canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
    });

    // WS-Security identifies signed elements by wsu:Id, which is not one
    // of xml-crypto's defaults.
    sig.idAttributes = ['wsu:Id', 'Id', 'ID', 'id'];

    // KeyInfo points back at the BinarySecurityToken rather than inlining
    // the certificate a second time — the WS-Security convention.
    sig.getKeyInfoContent = () =>
      `<wsse:SecurityTokenReference xmlns:wsse="${NS.wsse}">` +
      `<wsse:Reference URI="#X509Token" ValueType="${X509_TOKEN_TYPE}"/>` +
      `</wsse:SecurityTokenReference>`;

    for (const id of ['Timestamp', 'Body']) {
      sig.addReference({
        xpath: `//*[@*[local-name(.)='Id']='${id}']`,
        transforms: ['http://www.w3.org/2001/10/xml-exc-c14n#'],
        digestAlgorithm: 'http://www.w3.org/2000/09/xmldsig#sha1',
      });
    }

    sig.computeSignature(unsigned, {
      prefix: 'ds',
      location: {
        // The signature belongs inside wsse:Security, after the tokens.
        reference: `//*[local-name(.)='Security']`,
        action: 'append',
      },
    });

    return sig.getSignedXml();
  }

  private async post(envelope: string): Promise<string> {
    let res: Response;

    try {
      res = await fetch(this.config.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          SOAPAction: ELEMENTS.soapAction,
        },
        body: envelope,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      throw new HcvError('network_error', `Could not reach the ministry service: ${(err as Error).message}`);
    }

    const text = await res.text();

    if (res.status >= 500) {
      throw new HcvError('server_error', `Ministry service error (${res.status}).`);
    }

    if (!res.ok) {
      // A SOAP Fault often arrives with a 4xx and explains itself far
      // better than the status line does.
      throw new HcvError('bad_request', extractFault(text) ?? `Ministry service rejected the request (${res.status}).`);
    }

    return text;
  }

  parseResponse(xml: string): EligibilityResult {
    const fault = extractFault(xml);
    if (fault) {
      throw new HcvError('bad_request', fault);
    }

    const responseCode = firstTagValue(xml, 'ResponseCode') ?? firstTagValue(xml, 'responseCode');

    if (!responseCode) {
      throw new HcvError('invalid_response', 'The ministry response contained no response code.');
    }

    const { eligible, description } = describeResponseCode(responseCode);

    return {
      isEligible: eligible,
      responseCode,
      responseDescription: firstTagValue(xml, 'ResponseDescription') ?? description,
      firstName: firstTagValue(xml, 'FirstName'),
      lastName: firstTagValue(xml, 'LastName'),
      expiryDate: firstTagValue(xml, 'ExpiryDate'),
      mode: this.config.mode,
      raw: xml,
    };
  }
}

/**
 * Reads an element's text by local name, ignoring namespace prefixes —
 * the ministry's prefixes are not guaranteed stable, and a full XML parse
 * is unnecessary for these few flat fields.
 */
export function firstTagValue(xml: string, localName: string): string | null {
  const match = new RegExp(`<(?:\\w+:)?${localName}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${localName}>`, 'i').exec(
    xml,
  );
  if (!match) return null;
  const value = match[1].trim();
  return value === '' ? null : value;
}

export function extractFault(xml: string): string | null {
  if (!/<(?:\w+:)?Fault\b/i.test(xml)) return null;

  const reason =
    firstTagValue(xml, 'faultstring') ??
    firstTagValue(xml, 'Text') ??
    firstTagValue(xml, 'Reason') ??
    'The ministry service returned a SOAP fault.';

  return reason;
}
