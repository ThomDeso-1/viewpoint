/**
 * Row types for the exam-request workflow (migration 003-exams.sql).
 *
 * Kept separate from db.ts, which stays focused on the connection, the
 * migration runner, and the original receipts domain.
 *
 * Naming follows the existing ReceiptRow convention: snake_case fields
 * mirroring the columns exactly, `| null` for every nullable column, and
 * JSON blobs typed as TEXT to be parsed at the edge.
 */

// ── Status machines ──

/**
 * An exam request's journey, mirroring the receipts pipeline's shape
 * (captured → extracted → reviewed → uploaded) so the two queues behave
 * recognisably alike.
 *
 *   received → extracted → drafted → approved → completed
 *                    ↘ needsAttention      ↘ failed
 *
 * Everything up to `drafted` happens automatically. `approved` is the
 * only transition a human makes, and nothing is sent to a patient or
 * committed to Wave before it.
 */
export type ExamRequestStatus =
  | 'received'
  | 'extracted'
  | 'drafted'
  | 'approved'
  | 'completed'
  | 'rejected'
  | 'needsAttention'
  | 'failed';

export type AppointmentStatus = 'scheduled' | 'completed' | 'cancelled';

/** Where an appointment came from — a calendar event, or hand-entered. */
export type AppointmentSource = 'google' | 'manual';

export type ReminderStatus = 'pending' | 'sent' | 'failed' | 'cancelled';

export type ReminderChannelName = 'email' | 'sms';

export type InvoiceStatus = 'draft' | 'created' | 'approved' | 'sent' | 'failed';

/** Which HCV backend produced a result — a mock result must never be mistaken for a real one. */
export type HcvMode = 'mock' | 'conformance' | 'production';

export type OAuthProvider = 'google' | 'wave';

// ── Rows ──

export interface PatientRow {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  date_of_birth: string | null;
  /** AES-256-GCM blob — never a plaintext health card number. */
  health_card_enc: string | null;
  health_card_version: string | null;
  wave_customer_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  /** Soft-delete tombstone (migration 005) — reads filter this out. */
  deleted_at: string | null;
}

export interface AppointmentRow {
  id: string;
  patient_id: string | null;
  google_event_id: string | null;
  starts_at: string;
  ends_at: string | null;
  title: string | null;
  location: string | null;
  status: AppointmentStatus;
  source: AppointmentSource;
  created_at: string;
  updated_at: string;
}

export interface ExamRequestRow {
  id: string;
  gmail_message_id: string;
  gmail_thread_id: string | null;
  received_at: string;
  from_address: string | null;
  subject: string | null;
  body_snippet: string | null;
  /** Raw Claude extraction output — see ExamRequestExtraction. */
  extracted_json: string | null;
  status: ExamRequestStatus;
  patient_id: string | null;
  appointment_id: string | null;
  last_error: string | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
}

export interface EligibilityCheckRow {
  id: string;
  patient_id: string | null;
  appointment_id: string | null;
  checked_at: string;
  date_of_service: string | null;
  /** SQLite has no boolean: 1, 0, or null when the check never completed. */
  is_eligible: number | null;
  response_code: string | null;
  response_description: string | null;
  raw_response_enc: string | null;
  error: string | null;
  mode: HcvMode;
}

export interface ReminderRow {
  id: string;
  appointment_id: string;
  channel: ReminderChannelName;
  scheduled_for: string;
  status: ReminderStatus;
  subject: string | null;
  body: string | null;
  sent_at: string | null;
  provider_message_id: string | null;
  last_error: string | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
}

/** One editable line on a drafted invoice. */
export interface InvoiceLineItemDraft {
  description: string;
  quantity: number;
  unitPrice: number;
  /** A saved Wave product, or an income account — one of the two. */
  productId?: string | null;
  accountId?: string | null;
  salesTaxId?: string | null;
}

export interface WaveInvoiceRow {
  id: string;
  exam_request_id: string | null;
  appointment_id: string | null;
  patient_id: string | null;
  wave_invoice_id: string | null;
  wave_invoice_url: string | null;
  invoice_number: string | null;
  amount: number | null;
  currency: string;
  status: InvoiceStatus;
  /** JSON InvoiceLineItemDraft[] — see migration 004. */
  line_items: string | null;
  last_error: string | null;
  retry_count: number;
  created_at: string;
  updated_at: string;
}

export interface OAuthTokenRow {
  provider: OAuthProvider;
  access_token_enc: string;
  refresh_token_enc: string | null;
  expires_at: string | null;
  scope: string | null;
  account_label: string | null;
  created_at: string;
  updated_at: string;
}

// ── Extraction shape ──

/**
 * What Claude is asked to pull out of an exam-request email.
 *
 * Every field is optional because a real email may simply not mention it;
 * the queue decides what is missing and surfaces it for the operator to
 * fill in rather than guessing.
 */
export interface ExamRequestExtraction {
  patient_name: string | null;
  email: string | null;
  phone: string | null;
  date_of_birth: string | null;
  health_card_number: string | null;
  health_card_version: string | null;
  requested_date: string | null;
  requested_time: string | null;
  reason: string | null;
  /** 0–1, Claude's own confidence. Low values route to manual review. */
  confidence: number;
}
