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
  /** True when every external service is a local fake. */
  demoMode?: boolean;
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

// ── Practice: patients, schedule, exam requests ──

export interface Patient {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  date_of_birth: string | null;
  has_health_card: boolean;
  /** Masked for display — the API never returns the full number. */
  health_card_masked: string | null;
  health_card_version: string | null;
  wave_customer_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface EligibilityCheck {
  id: string;
  checked_at: string;
  date_of_service: string | null;
  is_eligible: boolean | null;
  response_code: string | null;
  response_description: string | null;
  error: string | null;
  /** 'mock' until ministry conformance testing is complete. */
  mode: string;
}

export interface Appointment {
  id: string;
  patient_id: string | null;
  google_event_id: string | null;
  starts_at: string;
  ends_at: string | null;
  title: string | null;
  location: string | null;
  status: string;
  source: string;
  patient?: Patient | null;
  eligibility?: EligibilityCheck | null;
}

export interface ExamRequestExtraction {
  patient_name: string | null;
  email: string | null;
  phone: string | null;
  date_of_birth: string | null;
  health_card_masked: string | null;
  health_card_version: string | null;
  requested_date: string | null;
  requested_time: string | null;
  reason: string | null;
  confidence: number;
}

export interface ExamRequestReminder {
  id: string;
  status: string;
  channel: string;
  scheduled_for: string;
  subject: string | null;
  body: string | null;
  sent_at: string | null;
  last_error: string | null;
}

export interface ExamRequestInvoice {
  id: string;
  status: string;
  amount: number | null;
  currency: string;
  wave_invoice_id: string | null;
  wave_invoice_url: string | null;
  invoice_number: string | null;
  last_error: string | null;
  line_items: InvoiceLineItem[];
  /** Only a local draft can be edited; once in Wave, Wave owns it. */
  editable: boolean;
}

export interface ExamRequest {
  id: string;
  status: string;
  received_at: string;
  from_address: string | null;
  subject: string | null;
  /** True if a slice of the original email was retained. Fetch it with
   *  getExamRequestSource() — it is PHI and access is audited. */
  has_source: boolean;
  extraction: ExamRequestExtraction | null;
  last_error: string | null;
  retry_count: number;
  patient: Patient | null;
  appointment: Appointment | null;
  eligibility: EligibilityCheck | null;
  reminder: ExamRequestReminder | null;
  invoice: ExamRequestInvoice | null;
}

export interface ExamRequestCounts {
  counts: Record<string, number>;
  hcvMode: string;
  gmailQueryConfigured: boolean;
}

export function getExamRequests(all = false): Promise<ExamRequest[]> {
  return request(`/practice/exam-requests${all ? '?all=true' : ''}`);
}

export function getExamRequest(id: string): Promise<ExamRequest> {
  return request(`/practice/exam-requests/${id}`);
}

/** The retained slice of the original email. Reading it is audited server-side. */
export function getExamRequestSource(id: string): Promise<{ body: string | null }> {
  return request(`/practice/exam-requests/${id}/source`);
}

export function getExamRequestCounts(): Promise<ExamRequestCounts> {
  return request('/practice/exam-requests/counts');
}

export function pollExamRequests(): Promise<{ success: boolean; created: number }> {
  return request('/practice/exam-requests/poll', { method: 'POST' });
}

export function approveExamRequest(id: string): Promise<{
  success: boolean;
  invoice: { created: boolean; error: string | null };
  reminder: { scheduled: boolean; error: string | null };
  request: ExamRequest;
}> {
  return request(`/practice/exam-requests/${id}/approve`, { method: 'POST' });
}

export function rejectExamRequest(id: string): Promise<{ success: boolean }> {
  return request(`/practice/exam-requests/${id}/reject`, { method: 'POST' });
}

export function retryExamRequest(id: string): Promise<{ success: boolean }> {
  return request(`/practice/exam-requests/${id}/retry`, { method: 'POST' });
}

export function getPatients(): Promise<Patient[]> {
  return request('/practice/patients');
}

export function getPatient(
  id: string,
): Promise<Patient & { appointments: Appointment[]; eligibility_history: EligibilityCheck[] }> {
  return request(`/practice/patients/${id}`);
}

export function updatePatient(id: string, fields: Partial<Patient> & { health_card_number?: string | null }) {
  return request<Patient>(`/practice/patients/${id}`, {
    method: 'PUT',
    body: JSON.stringify(fields),
  });
}

/** What the check-eligibility routes return (camelCase — not the snake_case DTO). */
export interface EligibilityOutcome {
  checkId: string;
  isEligible: boolean | null;
  responseCode: string | null;
  responseDescription: string | null;
  mode: string;
  error: string | null;
  checkedAt: string;
  /** True when a recent stored result was returned instead of a fresh ministry call. */
  reused?: boolean;
}

export function checkPatientEligibility(
  id: string,
  body: { appointmentId?: string; dateOfService?: string; force?: boolean } = {},
): Promise<EligibilityOutcome> {
  return request(`/practice/patients/${id}/check-eligibility`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function getAppointments(): Promise<Appointment[]> {
  return request('/practice/appointments');
}

export function checkAppointmentEligibility(id: string, force = false): Promise<EligibilityOutcome> {
  return request(`/practice/appointments/${id}/check-eligibility`, {
    method: 'POST',
    body: JSON.stringify({ force }),
  });
}

// ── Google connection ──

export interface GoogleStatus {
  configured: boolean;
  connected: boolean;
  redirectUri: string;
  accountLabel: string | null;
  scope: string | null;
  expiresAt: string | null;
}

export function getGoogleStatus(): Promise<GoogleStatus> {
  return request('/google/status');
}

export function saveGoogleCredentials(body: {
  clientId: string;
  clientSecret: string;
  calendarId?: string;
}): Promise<{ success: boolean; redirectUri: string }> {
  return request('/google/credentials', { method: 'POST', body: JSON.stringify(body) });
}

export function disconnectGoogle(): Promise<{ success: boolean }> {
  return request('/google/disconnect', { method: 'POST' });
}

// ── Invoice line items ──

export interface InvoiceLineItem {
  description: string;
  quantity: number;
  unitPrice: number;
  productId?: string | null;
  accountId?: string | null;
  salesTaxId?: string | null;
}

export function updateInvoiceLineItems(
  examRequestId: string,
  lineItems: InvoiceLineItem[],
): Promise<{ success: boolean; request: ExamRequest }> {
  return request(`/practice/exam-requests/${examRequestId}/invoice`, {
    method: 'PUT',
    body: JSON.stringify({ line_items: lineItems }),
  });
}

// ── Appointments (manual entry + linking) ──

export function createAppointment(body: {
  startsAt: string;
  endsAt?: string | null;
  title?: string | null;
  location?: string | null;
  patientId?: string | null;
}): Promise<Appointment> {
  return request('/practice/appointments', { method: 'POST', body: JSON.stringify(body) });
}

export function deleteAppointment(id: string): Promise<{ success: boolean }> {
  return request(`/practice/appointments/${id}`, { method: 'DELETE' });
}

export function linkPatientToAppointment(
  appointmentId: string,
  patientId: string,
): Promise<{ success: boolean }> {
  return request(`/practice/appointments/${appointmentId}/link-patient`, {
    method: 'POST',
    body: JSON.stringify({ patientId }),
  });
}

// ── Audit log ──

export interface AuditEntry {
  id: number;
  at: string;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  detail: string | null;
  ip: string | null;
}

export function getAuditLog(limit = 200): Promise<AuditEntry[]> {
  return request(`/practice/audit?limit=${limit}`);
}

/** Whether the audit-log hash chain is intact (detects an edited/deleted row). */
export function verifyAuditChain(): Promise<{ ok: boolean; brokenAtId: number | null }> {
  return request('/practice/audit/verify');
}

// ── Practice configuration ──

export interface PracticeSettings {
  gmailQuery: string;
  minConfidence: number;
  clinicName: string;
  clinicTimezone: string;
  reminderLeadHours: number;
  examFeeAmount: number;
  waveIncomeAccountId: string;
  waveServiceProductId: string;
  /** False until a service product or income account is chosen. */
  invoicingReady: boolean;
}

export function getPracticeSettings(): Promise<PracticeSettings> {
  return request('/settings/practice');
}

export function savePracticeSettings(body: Partial<PracticeSettings>): Promise<{ success: boolean }> {
  return request('/settings/practice', { method: 'POST', body: JSON.stringify(body) });
}

export interface WaveInvoiceTargets {
  income: { id: string; name: string }[];
  products: { id: string; name: string; unitPrice: number | null }[];
}

export function getWaveInvoiceTargets(): Promise<WaveInvoiceTargets> {
  return request('/settings/wave/income-accounts');
}

// ── OHIP configuration ──

export interface OhipSettings {
  mode: 'mock' | 'conformance' | 'production';
  privateKeyPath: string;
  certificatePath: string;
  caCertPath: string;
  username: string;
  mohId: string;
  /** Secrets are never returned — only whether they are set. */
  hasPassword: boolean;
  hasConformanceKey: boolean;
  endpoint: string;
}

export function getOhipSettings(): Promise<OhipSettings> {
  return request('/settings/ohip');
}

export function saveOhipSettings(
  body: Partial<OhipSettings> & { password?: string; conformanceKey?: string },
): Promise<{ success: boolean; mode: string }> {
  return request('/settings/ohip', { method: 'POST', body: JSON.stringify(body) });
}

export function testOhipConnection(body: { healthCardNumber?: string; versionCode?: string } = {}): Promise<{
  ok: boolean;
  checked?: 'configuration' | 'live';
  message?: string;
  isEligible?: boolean;
  responseCode?: string;
  responseDescription?: string;
  error?: string;
}> {
  return request('/settings/ohip/test', { method: 'POST', body: JSON.stringify(body) });
}
