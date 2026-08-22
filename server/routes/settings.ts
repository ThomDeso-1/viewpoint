import { Router, Request, Response } from 'express';
import { getConfig, setConfig } from '../db/db.js';
import { validateApiKey } from '../services/claude.js';
import { updateEnvConfig } from '../services/env-config.js';
import {
  validateToken,
  fetchExpenseAccounts,
  fetchAnchorAccounts,
  fetchSalesTaxes,
  checkTokenHealth,
} from '../services/wave.js';

export function settingsRoutes(): Router {
  const router = Router();

  // ── GET /api/settings — Current config (keys masked) ──
  router.get('/', (_req: Request, res: Response): void => {
    const claudeKey = process.env.CLAUDE_API_KEY || '';
    const waveToken = process.env.WAVE_ACCESS_TOKEN || '';

    res.json({
      hasClaudeKey: !!claudeKey,
      claudeKeyPreview: claudeKey ? maskKey(claudeKey) : null,
      hasWaveToken: !!waveToken,
      waveTokenPreview: waveToken ? maskKey(waveToken) : null,
      waveBusinessId: process.env.WAVE_BUSINESS_ID || '',
      waveBusinessName: process.env.WAVE_BUSINESS_NAME || '',
      waveExpenseAccountId: process.env.WAVE_EXPENSE_ACCOUNT_ID || '',
      waveAnchorAccountId: process.env.WAVE_ANCHOR_ACCOUNT_ID || '',
      waveSalesTaxId: process.env.WAVE_SALES_TAX_ID || '',
      isOnboarded: getConfig('onboarded') === 'true',
    });
  });

  // ── GET /api/settings/needs-setup — Does the app need first-run setup? ──
  router.get('/needs-setup', (_req: Request, res: Response): void => {
    const hasPassword = !!(process.env.APP_PASSWORD || getConfig('password_hash'));
    res.json({ needsSetup: !hasPassword });
  });

  // ── POST /api/settings/validate-claude-key — Test a Claude API key ──
  router.post('/validate-claude-key', async (req: Request, res: Response): Promise<void> => {
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
    const token = process.env.WAVE_ACCESS_TOKEN;
    const businessId = process.env.WAVE_BUSINESS_ID;
    if (!token || !businessId) {
      res.status(400).json({ error: 'Wave is not configured.' });
      return;
    }

    try {
      const [expense, anchor] = await Promise.all([
        fetchExpenseAccounts(businessId, token),
        fetchAnchorAccounts(businessId, token),
      ]);
      res.json({ expense, anchor });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/settings/wave/taxes — Fetch sales taxes ──
  router.get('/wave/taxes', async (_req: Request, res: Response): Promise<void> => {
    const token = process.env.WAVE_ACCESS_TOKEN;
    const businessId = process.env.WAVE_BUSINESS_ID;
    if (!token || !businessId) {
      res.status(400).json({ error: 'Wave is not configured.' });
      return;
    }

    try {
      const taxes = await fetchSalesTaxes(businessId, token);
      res.json(taxes);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/settings/wave/health — Quick token health check ──
  router.get('/wave/health', async (_req: Request, res: Response): Promise<void> => {
    const token = process.env.WAVE_ACCESS_TOKEN;
    if (!token) {
      res.json({ healthy: false, reason: 'No token configured.' });
      return;
    }

    const healthy = await checkTokenHealth(token);
    res.json({ healthy, reason: healthy ? null : 'Token is invalid or expired.' });
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

  // ── POST /api/settings/onboard — Mark onboarding complete ──
  router.post('/onboard', (_req: Request, res: Response): void => {
    setConfig('onboarded', 'true');
    res.json({ success: true });
  });

  return router;
}

function maskKey(key: string): string {
  if (key.length <= 8) return '****';
  return key.slice(0, 8) + '…' + key.slice(-4);
}
