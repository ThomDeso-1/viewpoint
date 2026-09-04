import { Router, Request, Response } from 'express';
import { getConfig, setConfig } from '../db/db.js';
import { validateApiKey } from '../integrations/claude.js';
import { updateEnvConfig } from '../platform/env-config.js';
import {
  validateToken,
  fetchExpenseAndAnchorAccounts,
  fetchSalesTaxes,
  fetchIncomeAccounts,
  fetchProducts,
  checkTokenHealth,
} from '../integrations/wave/index.js';
import { getWaveToken, isWaveConfigured, authMode } from '../integrations/wave/auth.js';
import { hcvMode, ohipEnabled, resetHcvClient, loadConfigFromEnv, SoapHcvClient, HcvError } from '../integrations/ohip/index.js';
import { isDemoMode } from '../platform/endpoints.js';
import { isConnected } from '../platform/oauth-store.js';
import { rateLimited } from '../platform/rate-limit.js';
import path from 'path';
import { walkSourceDir, SourceFolderError } from '../exams/file-source.js';

import fs from 'fs';

function folderExists(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Persists a PEM the operator pasted/uploaded into DATA_DIR/ohip/ and
 * returns its absolute path — so OHIP setup needs no Terminal or
 * filesystem access on the host. Private key is written 0600.
 */
function writeOhipPem(name: 'private-key' | 'certificate' | 'ca-cert', contents: string): string {
  const dir = path.resolve(process.env.DATA_DIR || './data', 'ohip');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${name}.pem`);
  fs.writeFileSync(file, contents.trim() + '\n', { mode: 0o600 });
  return file;
}

const HEALTH_CACHE_MS = 5 * 60 * 1000; // re-check credentials at most every 5 minutes
let claudeHealthCache: { healthy: boolean; checkedAt: number } | null = null;
let waveHealthCache: { healthy: boolean; checkedAt: number } | null = null;

export function settingsRoutes(): Router {
  const router = Router();

  // ── GET /api/settings — Current config (keys masked) ──
  router.get('/', (_req: Request, res: Response): void => {
    const claudeKey = process.env.CLAUDE_API_KEY || '';
    const waveToken = process.env.WAVE_ACCESS_TOKEN || '';

    res.json({
      hasClaudeKey: !!claudeKey,
      claudeKeyPreview: claudeKey ? maskKey(claudeKey) : null,
      // In OAuth mode there is no pasted token to preview — connection
      // state comes from the token store instead.
      hasWaveToken: isWaveConfigured(),
      waveTokenPreview: waveToken ? maskKey(waveToken) : null,
      waveAuthMode: authMode(),
      waveBusinessId: process.env.WAVE_BUSINESS_ID || '',
      waveBusinessName: process.env.WAVE_BUSINESS_NAME || '',
      waveExpenseAccountId: process.env.WAVE_EXPENSE_ACCOUNT_ID || '',
      waveAnchorAccountId: process.env.WAVE_ANCHOR_ACCOUNT_ID || '',
      waveSalesTaxId: process.env.WAVE_SALES_TAX_ID || '',
      isOnboarded: getConfig('onboarded') === 'true',
      demoMode: isDemoMode(),
      // The Outlook / Microsoft 365 connection — mail send + calendar sync.
      microsoftConnected: isConnected('microsoft'),
    });
  });

  // ── POST /api/settings/validate-claude-key — Test a Claude API key ──
  router.post('/validate-claude-key', rateLimited('claude-validate', 15, 60_000), async (req: Request, res: Response): Promise<void> => {
    const { apiKey } = req.body;
    if (!apiKey) {
      res.status(400).json({ error: 'API key is required.' });
      return;
    }

    try {
      await validateApiKey(apiKey);
      res.json({ valid: true });
    } catch (err: any) {
      res.json({ valid: false, error: err.message });
    }
  });

  // ── POST /api/settings/validate-wave-token — Test a Wave token, return businesses ──
  router.post('/validate-wave-token', async (req: Request, res: Response): Promise<void> => {
    const { token } = req.body;
    if (!token) {
      res.status(400).json({ error: 'Token is required.' });
      return;
    }

    try {
      const businesses = await validateToken(token);
      res.json({ valid: true, businesses });
    } catch (err: any) {
      res.json({ valid: false, error: err.message });
    }
  });

  // ── GET /api/settings/wave/accounts — Fetch expense & anchor accounts ──
  router.get('/wave/accounts', async (_req: Request, res: Response): Promise<void> => {
    const businessId = process.env.WAVE_BUSINESS_ID;
    if (!isWaveConfigured() || !businessId) {
      res.status(400).json({ error: 'Wave is not configured.' });
      return;
    }

    try {
      const token = await getWaveToken();
      const { expense, anchor } = await fetchExpenseAndAnchorAccounts(businessId, token);
      res.json({ expense, anchor });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/settings/wave/taxes — Fetch sales taxes ──
  router.get('/wave/taxes', async (_req: Request, res: Response): Promise<void> => {
    const businessId = process.env.WAVE_BUSINESS_ID;
    if (!isWaveConfigured() || !businessId) {
      res.status(400).json({ error: 'Wave is not configured.' });
      return;
    }

    try {
      const token = await getWaveToken();
      const taxes = await fetchSalesTaxes(businessId, token);
      res.json(taxes);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/settings/wave/health — Quick token health check ──
  router.get('/wave/health', async (_req: Request, res: Response): Promise<void> => {
    if (!isWaveConfigured()) {
      res.json({ healthy: false, reason: 'No token configured.' });
      return;
    }

    try {
      const healthy = await checkTokenHealth(await getWaveToken());
      res.json({ healthy, reason: healthy ? null : 'Token is invalid or expired.' });
    } catch (err: any) {
      // In OAuth mode a refresh can fail outright, which is itself the
      // health answer rather than a 500.
      res.json({ healthy: false, reason: err.message });
    }
  });

  // ── POST /api/settings/claude-key — Save the Claude API key ──
  router.post('/claude-key', (req: Request, res: Response): void => {
    const { apiKey } = req.body;
    if (!apiKey || typeof apiKey !== 'string') {
      res.status(400).json({ error: 'API key is required.' });
      return;
    }

    updateEnvConfig({ CLAUDE_API_KEY: apiKey });
    res.json({ success: true });
  });

  // ── POST /api/settings/wave-connection — Save Wave token + selected business ──
  router.post('/wave-connection', (req: Request, res: Response): void => {
    const { token, businessId, businessName } = req.body;
    if (!token || typeof token !== 'string' || !businessId || typeof businessId !== 'string') {
      res.status(400).json({ error: 'Token and business are required.' });
      return;
    }

    updateEnvConfig({
      WAVE_ACCESS_TOKEN: token,
      WAVE_BUSINESS_ID: businessId,
      WAVE_BUSINESS_NAME: businessName || '',
    });
    res.json({ success: true });
  });

  // ── POST /api/settings/wave-accounts — Save expense/anchor accounts + sales tax ──
  router.post('/wave-accounts', (req: Request, res: Response): void => {
    const { expenseAccountId, anchorAccountId, salesTaxId } = req.body;
    if (
      !expenseAccountId ||
      typeof expenseAccountId !== 'string' ||
      !anchorAccountId ||
      typeof anchorAccountId !== 'string'
    ) {
      res.status(400).json({ error: 'Expense and anchor accounts are required.' });
      return;
    }

    updateEnvConfig({
      WAVE_EXPENSE_ACCOUNT_ID: expenseAccountId,
      WAVE_ANCHOR_ACCOUNT_ID: anchorAccountId,
      WAVE_SALES_TAX_ID: salesTaxId || '',
    });
    res.json({ success: true });
  });

  // ── GET /api/settings/health — Cached credential health for the list banner ──
  router.get('/health', async (_req: Request, res: Response): Promise<void> => {
    const claudeKey = process.env.CLAUDE_API_KEY;
    const now = Date.now();

    let claudeHealthy: boolean | null = null;
    if (claudeKey) {
      if (!claudeHealthCache || now - claudeHealthCache.checkedAt > HEALTH_CACHE_MS) {
        try {
          await validateApiKey(claudeKey);
          claudeHealthCache = { healthy: true, checkedAt: now };
        } catch {
          claudeHealthCache = { healthy: false, checkedAt: now };
        }
      }
      claudeHealthy = claudeHealthCache.healthy;
    }

    let waveHealthy: boolean | null = null;
    if (isWaveConfigured()) {
      if (!waveHealthCache || now - waveHealthCache.checkedAt > HEALTH_CACHE_MS) {
        let healthy = false;
        try {
          healthy = await checkTokenHealth(await getWaveToken());
        } catch {
          // A failed OAuth refresh means unhealthy, same as a rejected token.
          healthy = false;
        }
        waveHealthCache = { healthy, checkedAt: now };
      }
      waveHealthy = waveHealthCache.healthy;
    }

    res.json({
      claudeConfigured: !!claudeKey,
      claudeHealthy,
      waveConfigured: isWaveConfigured(),
      waveHealthy,
    });
  });

  // ── POST /api/settings/onboard — Mark onboarding complete ──
  router.post('/onboard', (_req: Request, res: Response): void => {
    setConfig('onboarded', 'true');
    res.json({ success: true });
  });

  // ── GET /api/settings/wave/income-accounts — for invoice line items ──
  router.get('/wave/income-accounts', async (_req: Request, res: Response): Promise<void> => {
    const businessId = process.env.WAVE_BUSINESS_ID;
    if (!isWaveConfigured() || !businessId) {
      res.status(400).json({ error: 'Wave is not configured.' });
      return;
    }

    try {
      const token = await getWaveToken();
      // An invoice line needs one or the other, so the UI offers both
      // lists together and they share the single connection.
      const [income, products] = await Promise.all([
        fetchIncomeAccounts(businessId, token),
        fetchProducts(businessId, token),
      ]);
      res.json({ income, products });
    } catch (err: any) {
      res.status(502).json({ error: err.message });
    }
  });

  // ── GET /api/settings/exams — exam-request workflow configuration ──
  router.get('/exams', (_req: Request, res: Response): void => {
    const sourceFolder = process.env.EXAM_REQUEST_SOURCE_DIR || '';
    res.json({
      sourceFolder,
      sourceFolderExists: sourceFolder ? folderExists(sourceFolder) : false,
      minConfidence: Number(process.env.EXAM_REQUEST_MIN_CONFIDENCE) || 0.6,
      businessName: process.env.BUSINESS_NAME || '',
      businessTimezone: process.env.BUSINESS_TIMEZONE || 'America/Toronto',
      reminderLeadHours: Number(process.env.REMINDER_LEAD_HOURS) || 24,
      examFeeAmount: Number(process.env.EXAM_FEE_AMOUNT) || 0,
      waveIncomeAccountId: process.env.WAVE_INCOME_ACCOUNT_ID || '',
      waveServiceProductId: process.env.WAVE_SERVICE_PRODUCT_ID || '',
      // An invoice needs a line item, so one of the two above must be set
      // before approving a request can do anything.
      invoicingReady: !!(process.env.WAVE_INCOME_ACCOUNT_ID || process.env.WAVE_SERVICE_PRODUCT_ID),
    });
  });

  // ── POST /api/settings/exams ──
  router.post('/exams', (req: Request, res: Response): void => {
    const {
      sourceFolder,
      minConfidence,
      businessName,
      businessTimezone,
      reminderLeadHours,
      examFeeAmount,
      waveIncomeAccountId,
      waveServiceProductId,
    } = req.body;

    if (minConfidence !== undefined && (Number(minConfidence) < 0 || Number(minConfidence) > 1)) {
      res.status(400).json({ error: 'Confidence threshold must be between 0 and 1.' });
      return;
    }

    if (reminderLeadHours !== undefined && Number(reminderLeadHours) <= 0) {
      res.status(400).json({ error: 'Reminder lead time must be more than zero hours.' });
      return;
    }

    if (examFeeAmount !== undefined && Number(examFeeAmount) < 0) {
      res.status(400).json({ error: 'Exam fee cannot be negative.' });
      return;
    }

    // A product and an income account are alternatives, not a pair —
    // setting both would make the invoice line ambiguous.
    if (waveIncomeAccountId && waveServiceProductId) {
      res.status(400).json({ error: 'Choose either a service product or an income account, not both.' });
      return;
    }

    const folder = sourceFolder === undefined ? undefined : String(sourceFolder).trim();
    if (folder && !path.isAbsolute(folder)) {
      res.status(400).json({ error: 'The patient files folder must be an absolute path.' });
      return;
    }

    const updates: Record<string, string> = {};
    if (folder !== undefined) updates.EXAM_REQUEST_SOURCE_DIR = folder;
    if (minConfidence !== undefined) updates.EXAM_REQUEST_MIN_CONFIDENCE = String(minConfidence);
    if (businessName !== undefined) updates.BUSINESS_NAME = String(businessName).trim();
    if (businessTimezone !== undefined) updates.BUSINESS_TIMEZONE = String(businessTimezone).trim();
    if (reminderLeadHours !== undefined) updates.REMINDER_LEAD_HOURS = String(reminderLeadHours);
    if (examFeeAmount !== undefined) updates.EXAM_FEE_AMOUNT = String(examFeeAmount);
    if (waveIncomeAccountId !== undefined) updates.WAVE_INCOME_ACCOUNT_ID = String(waveIncomeAccountId);
    if (waveServiceProductId !== undefined) updates.WAVE_SERVICE_PRODUCT_ID = String(waveServiceProductId);

    updateEnvConfig(updates);
    res.json({ success: true });
  });

  // ── POST /api/settings/exams/test-folder — check a folder before saving it ──
  router.post(
    '/exams/test-folder',
    rateLimited('exam-folder-test', 20, 60_000),
    (req: Request, res: Response): void => {
      const folder = String(req.body?.sourceFolder ?? process.env.EXAM_REQUEST_SOURCE_DIR ?? '').trim();
      if (!folder) {
        res.status(400).json({ ok: false, error: 'No folder path given.' });
        return;
      }
      if (!path.isAbsolute(folder)) {
        res.status(400).json({ ok: false, error: 'The folder must be an absolute path.' });
        return;
      }

      try {
        const { files, tooLarge } = walkSourceDir(folder);
        const byExtension: Record<string, number> = {};
        for (const f of files) byExtension[f.ext] = (byExtension[f.ext] ?? 0) + 1;

        res.json({
          ok: true,
          fileCount: files.length,
          byExtension,
          sampleNames: files.slice(0, 10).map((f) => f.relativePath),
          tooLarge,
        });
      } catch (err) {
        const message =
          err instanceof SourceFolderError ? err.message : (err as Error).message;
        res.status(400).json({ ok: false, error: message });
      }
    },
  );

  // ── GET /api/settings/ohip — configuration state, never the secrets ──
  router.get('/ohip', (_req: Request, res: Response): void => {
    if (!ohipEnabled()) {
      res.status(403).json({ error: 'OHIP integration is disabled.' });
      return;
    }
    res.json({
      mode: hcvMode(),
      privateKeyPath: process.env.OHIP_PRIVATE_KEY_PATH || '',
      certificatePath: process.env.OHIP_CERTIFICATE_PATH || '',
      caCertPath: process.env.OHIP_CA_CERT_PATH || '',
      // The PEM contents can be pasted into the app now; these say whether
      // one is stored without ever returning it.
      hasPrivateKey: !!process.env.OHIP_PRIVATE_KEY_PATH,
      hasCertificate: !!process.env.OHIP_CERTIFICATE_PATH,
      hasCaCert: !!process.env.OHIP_CA_CERT_PATH,
      username: process.env.OHIP_USERNAME || '',
      mohId: process.env.OHIP_MOH_ID || '',
      hasPassword: !!process.env.OHIP_PASSWORD,
      hasConformanceKey: !!process.env.OHIP_CONFORMANCE_KEY,
      endpoint: process.env.OHIP_ENDPOINT || '',
    });
  });

  // ── POST /api/settings/ohip ──
  router.post('/ohip', (req: Request, res: Response): void => {
    if (!ohipEnabled()) {
      res.status(403).json({ error: 'OHIP integration is disabled.' });
      return;
    }
    const {
      mode,
      privateKeyPath,
      certificatePath,
      caCertPath,
      privateKeyPem,
      certificatePem,
      caCertPem,
      username,
      password,
      mohId,
      conformanceKey,
      endpoint,
    } = req.body;

    if (mode !== undefined && !['mock', 'conformance', 'production'].includes(mode)) {
      res.status(400).json({ error: 'Mode must be "mock", "conformance", or "production".' });
      return;
    }

    // PEM contents pasted/uploaded through the app are written into
    // DATA_DIR/ohip/ so the operator never touches the Mac's filesystem;
    // hcv-soap.ts still just reads a path.
    let pemError: string | null = null;
    const pemPaths: Record<string, string> = {};
    for (const [field, value, name] of [
      ['OHIP_PRIVATE_KEY_PATH', privateKeyPem, 'private-key'],
      ['OHIP_CERTIFICATE_PATH', certificatePem, 'certificate'],
      ['OHIP_CA_CERT_PATH', caCertPem, 'ca-cert'],
    ] as const) {
      if (value === undefined || value === '') continue;
      const text = String(value);
      if (!text.includes('-----BEGIN')) {
        pemError = `The ${name.replace('-', ' ')} does not look like a PEM file.`;
        break;
      }
      pemPaths[field] = writeOhipPem(name, text);
    }
    if (pemError) {
      res.status(400).json({ error: pemError });
      return;
    }

    const updates: Record<string, string> = { ...pemPaths };
    if (mode !== undefined) updates.OHIP_HCV_MODE = mode;
    if (privateKeyPath !== undefined && pemPaths.OHIP_PRIVATE_KEY_PATH === undefined)
      updates.OHIP_PRIVATE_KEY_PATH = String(privateKeyPath).trim();
    if (certificatePath !== undefined && pemPaths.OHIP_CERTIFICATE_PATH === undefined)
      updates.OHIP_CERTIFICATE_PATH = String(certificatePath).trim();
    if (caCertPath !== undefined && pemPaths.OHIP_CA_CERT_PATH === undefined)
      updates.OHIP_CA_CERT_PATH = String(caCertPath).trim();
    if (username !== undefined) updates.OHIP_USERNAME = String(username).trim();
    if (mohId !== undefined) updates.OHIP_MOH_ID = String(mohId).trim();
    if (endpoint !== undefined) updates.OHIP_ENDPOINT = String(endpoint).trim();
    // Secrets are overwritten only when actually supplied, so saving the
    // form without retyping them does not wipe them.
    if (password) updates.OHIP_PASSWORD = String(password);
    if (conformanceKey) updates.OHIP_CONFORMANCE_KEY = String(conformanceKey);

    updateEnvConfig(updates);

    // The client is cached per mode; credentials may have changed under it.
    resetHcvClient();

    res.json({ success: true, mode: hcvMode() });
  });

  /**
   * POST /api/settings/ohip/test — check the configuration is usable.
   *
   * Without a health number this validates credentials and proves a
   * signed envelope can be built, which catches the common failures
   * (unreadable PEM, wrong key, missing conformance key) without
   * contacting the ministry. With one, it runs a real validation.
   */
  router.post('/ohip/test', rateLimited('ohip-test', 15, 60_000), async (req: Request, res: Response): Promise<void> => {
    if (!ohipEnabled()) {
      res.status(403).json({ error: 'OHIP integration is disabled.' });
      return;
    }
    if (hcvMode() === 'mock') {
      res.status(400).json({
        error: 'OHIP is in mock mode. Switch to conformance or production to test real credentials.',
      });
      return;
    }

    try {
      const config = loadConfigFromEnv();
      const client = new SoapHcvClient(config);
      const { healthCardNumber, versionCode } = req.body ?? {};

      if (!healthCardNumber) {
        client.buildSignedEnvelope({ healthCardNumber: '1234567890' });
        res.json({
          ok: true,
          checked: 'configuration',
          message: `Credentials load and a signed request builds. Endpoint: ${config.endpoint}`,
        });
        return;
      }

      const result = await client.checkEligibility({ healthCardNumber, versionCode });
      res.json({
        ok: true,
        checked: 'live',
        isEligible: result.isEligible,
        responseCode: result.responseCode,
        responseDescription: result.responseDescription,
      });
    } catch (err: any) {
      res.status(err instanceof HcvError && err.code === 'not_configured' ? 400 : 502).json({
        ok: false,
        error: err.message,
      });
    }
  });

  return router;
}

function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return key.slice(0, 8) + '…' + key.slice(-4);
}
