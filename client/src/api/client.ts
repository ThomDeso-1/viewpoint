/** Thin wrapper around fetch for the Viewpoint Receipts API. */

const BASE = '/api';

async function request<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: {
      ...(opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...((opts.headers as Record<string, string>) ?? {}),
    },
    ...opts,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));

    if (res.status === 401 && path !== '/auth/login') {
      // Redirect to login unless we're already there
      if (!window.location.pathname.startsWith('/login') && !window.location.pathname.startsWith('/setup')) {
        window.location.href = '/login';
      }
    }

    throw new Error(body.error || `Request failed: ${res.status}`);
  }

  return res.json();
}

// ── Auth ──

export interface AuthStatus {
  authenticated: boolean;
  needsSetup: boolean;
  needsOnboarding: boolean;
}

export function getAuthStatus(): Promise<AuthStatus> {
  return request('/auth/status');
}

export function login(password: string): Promise<{ success: boolean }> {
  return request('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}

export function setup(password: string): Promise<{ success: boolean }> {
  return request('/auth/setup', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}

export function logout(): Promise<{ success: boolean }> {
  return request('/auth/logout', { method: 'POST' });
}

// ── Receipts ──

export interface ReceiptRow {
  id: string;
  primary_image: string;
  additional_images: string;
  receipt_date: string;
  capture_date: string;
  month_folder: string;
  status: string;
  vendor: string | null;
  summary: string | null;
  total_amount: number | null;
  tax_amount: number | null;
  currency: string;
  extracted_json: string | null;
  wave_txn_id: string | null;
  last_error: string | null;
  retry_count: number;
  image_hash: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReceiptGroup {
  month: string;
  receipts: ReceiptRow[];
}

export interface QueueStatus {
  uploaded: number;
  pending: number;
  failed: number;
  captured: number;
}

export function listReceipts(params?: { search?: string; status?: string }): Promise<ReceiptGroup[]> {
  const qs = new URLSearchParams();
  if (params?.search) qs.set('search', params.search);
  if (params?.status) qs.set('status', params.status);
  const q = qs.toString();
  return request(`/receipts${q ? '?' + q : ''}`);
}

export function getReceipt(id: string): Promise<ReceiptRow> {
  return request(`/receipts/${id}`);
}

export function deleteReceipt(id: string): Promise<{ deleted: boolean }> {
  return request(`/receipts/${id}`, { method: 'DELETE' });
}

export function uploadImages(files: File[]): Promise<ReceiptRow[]> {
  const form = new FormData();
  files.forEach((f) => form.append('images', f));
  return request('/receipts', { method: 'POST', body: form });
}

export function getQueueStatus(): Promise<QueueStatus> {
  return request('/receipts/queue/status');
}

// ── Settings ──

export interface Settings {
  hasClaudeKey: boolean;
  claudeKeyPreview: string | null;
  hasWaveToken: boolean;
  waveTokenPreview: string | null;
  waveBusinessId: string;
  waveBusinessName: string;
  waveExpenseAccountId: string;
  waveAnchorAccountId: string;
  waveSalesTaxId: string;
  isOnboarded: boolean;
}

export function getSettings(): Promise<Settings> {
  return request('/settings');
}

// ── Extraction ──

export function extractReceipt(id: string): Promise<ReceiptRow> {
  return request(`/receipts/${id}/extract`, { method: 'POST' });
}

// ── Review / Update ──

export function updateReceipt(
  id: string,
  data: {
    receipt_date?: string;
    vendor?: string;
    summary?: string;
    total_amount?: number | null;
    tax_amount?: number | null;
    currency?: string;
    status?: string;
  },
): Promise<ReceiptRow> {
  return request(`/receipts/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

// ── Duplicates ──

export function checkDuplicates(id: string): Promise<{ warnings: string[] }> {
  return request(`/receipts/${id}/duplicates`);
}

// ── Retry ──

export function retryReceipt(id: string): Promise<{ success: boolean }> {
  return request(`/receipts/${id}/retry`, { method: 'POST' });
}

export function retryAllFailed(): Promise<{ success: boolean }> {
  return request('/receipts/retry-all', { method: 'POST' });
}

// ── Settings validation ──

export function validateClaudeKey(apiKey: string): Promise<{ valid: boolean; error?: string }> {
  return request('/settings/validate-claude-key', {
    method: 'POST',
    body: JSON.stringify({ apiKey }),
  });
}

export function validateWaveToken(
  token: string,
): Promise<{ valid: boolean; businesses?: { id: string; name: string; isPersonal: boolean }[]; error?: string }> {
  return request('/settings/validate-wave-token', {
    method: 'POST',
    body: JSON.stringify({ token }),
  });
}

export function getWaveAccounts(): Promise<{
  expense: { id: string; name: string }[];
  anchor: { id: string; name: string }[];
}> {
  return request('/settings/wave/accounts');
}

export function getWaveTaxes(): Promise<{ id: string; name: string; rate: number }[]> {
  return request('/settings/wave/taxes');
}

export function getWaveHealth(): Promise<{ healthy: boolean; reason?: string }> {
  return request('/settings/wave/health');
}

export interface HealthStatus {
  claudeConfigured: boolean;
  claudeHealthy: boolean | null;
  waveConfigured: boolean;
  waveHealthy: boolean | null;
}

export function getHealthStatus(): Promise<HealthStatus> {
  return request('/settings/health');
}

export function markOnboarded(): Promise<{ success: boolean }> {
  return request('/settings/onboard', { method: 'POST' });
}

// ── Onboarding wizard: save credentials ──

export function saveClaudeKey(apiKey: string): Promise<{ success: boolean }> {
  return request('/settings/claude-key', {
    method: 'POST',
    body: JSON.stringify({ apiKey }),
  });
}

export function saveWaveConnection(data: {
  token: string;
  businessId: string;
  businessName: string;
}): Promise<{ success: boolean }> {
  return request('/settings/wave-connection', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export function saveWaveAccounts(data: {
  expenseAccountId: string;
  anchorAccountId: string;
  salesTaxId?: string;
}): Promise<{ success: boolean }> {
  return request('/settings/wave-accounts', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}
