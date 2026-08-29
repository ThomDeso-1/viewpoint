import { getDb } from '../db/db.js';
import { v4 as uuid } from 'uuid';
import type { ExamRequestRow, WaveInvoiceRow, InvoiceLineItemDraft } from './types.js';
import { getConfig, setConfig } from '../db/db.js';
import * as examRequests from './exam-requests.js';
import * as patients from './patients.js';
import * as appointments from './appointments.js';
import * as reminders from './reminders.js';
import { listMessages, getMessage } from '../integrations/google/gmail.js';
import { listEvents, matchEvent } from '../integrations/google/calendar.js';
import { isGoogleConnected, GoogleAuthError } from '../integrations/google/auth.js';
import { extractExamRequest, ClaudeAPIError } from '../integrations/claude.js';
import { checkPatientEligibility } from './eligibility.js';
import { findOrCreateCustomer, createInvoice, approveInvoice, sendInvoice, WaveAPIError } from '../integrations/wave/index.js';
import { getWaveToken, isWaveConfigured } from '../integrations/wave/auth.js';
import { isReadyForRetry } from '../platform/backoff.js';
import { makePoller } from '../platform/poller.js';
import { audit } from '../platform/audit.js';

/**
 * The automation queue.
 *
 * Turns an incoming email into a drafted, reviewable package: patient
 * matched, appointment linked, eligibility checked, invoice drafted,
 * reminder composed. Steps 1–5 run on their own; step 6 — anything a
 * patient or the books actually sees — only ever runs after the operator
 * taps Approve.
 *
 * Shares the receipt queue's design rather than introducing a job
 * library: a re-entry guard, a 60s interval, and backoff that is stored
 * on the row instead of slept (see backoff.ts).
 */

const POLL_INTERVAL_MS = 60_000;
const MAX_RETRIES = 5;

/** Re-polled deliberately to cover messages that land near a boundary. */
const POLL_OVERLAP_MS = 10 * 60 * 1000;

const LAST_POLL_KEY = 'gmail_last_poll_at';

// ── Configuration ──

export function gmailQuery(): string | null {
  const query = process.env.GMAIL_EXAM_REQUEST_QUERY?.trim();
  return query || null;
}

function claudeKey(): string | null {
  return process.env.CLAUDE_API_KEY || null;
}

/** Below this, an extraction is queued for review rather than drafted. */
function confidenceThreshold(): number {
  const value = Number(process.env.EXAM_REQUEST_MIN_CONFIDENCE);
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0.6;
}

// ── Main pass ──

export async function processQueue(): Promise<void> {
  await pollGmail();
  await extractPending();
  await draftPending();
  await retryApproved();
  await sendDueReminders();
}

/** Step 1 — pull new exam-request emails into the queue. */
export async function pollGmail(): Promise<number> {
  const query = gmailQuery();
  if (!query || !isGoogleConnected()) return 0;

  const lastPoll = getConfig(LAST_POLL_KEY);
  const since = lastPoll
    ? Math.floor((new Date(lastPoll).getTime() - POLL_OVERLAP_MS) / 1000)
    : undefined;

  let created = 0;

  try {
    const summaries = await listMessages(query, since);

    for (const summary of summaries) {
      // Skip the fetch entirely for anything already recorded — the
      // overlap window means most results are usually already known.
      if (examRequests.findByGmailMessageId(summary.id)) continue;

      const message = await getMessage(summary.id);
      const { isNew } = examRequests.createFromGmailMessage(message);
      if (isNew) created++;
    }

    // Only advance the watermark on a clean pass, so a mid-poll failure
    // cannot skip messages.
    setConfig(LAST_POLL_KEY, new Date().toISOString());
  } catch (err) {
    console.error('[exams-queue] Gmail poll failed:', (err as Error).message);
  }

  return created;
}

/** Step 2 — parse each new email into structured details. */
export async function extractPending(): Promise<void> {
  const key = claudeKey();
  if (!key) return;

  for (const row of examRequests.listByStatus('received')) {
    if (!isReadyForRetry(row)) continue;

    try {
      const { result, rawJSON } = await extractExamRequest(
        {
          from: row.from_address,
          subject: row.subject,
          body: row.body_snippet ?? '',
          receivedAt: row.received_at,
        },
        key,
      );

      examRequests.saveExtraction(row.id, rawJSON);

      // A low-confidence read usually means the email isn't an exam
      // request at all. Park it for the operator instead of creating a
      // patient and an invoice from a guess.
      if (result.confidence < confidenceThreshold()) {
        examRequests.recordFailure(
          row.id,
          `Low confidence (${result.confidence.toFixed(2)}) — please review manually.`,
          false,
        );
      }
    } catch (err) {
      const retryable = err instanceof ClaudeAPIError && err.isRetryable;
      examRequests.recordFailure(row.id, (err as Error).message, retryable, MAX_RETRIES);
    }
  }
}

/** Steps 3–5 — match, check eligibility, and draft. Nothing is sent. */
export async function draftPending(): Promise<void> {
  for (const row of examRequests.listByStatus('extracted')) {
    if (!isReadyForRetry(row)) continue;

    try {
      await draftOne(row);
    } catch (err) {
      const retryable =
        (err instanceof WaveAPIError && err.isRetryable) ||
        (err instanceof GoogleAuthError && err.isRetryable);
      examRequests.recordFailure(row.id, (err as Error).message, retryable, MAX_RETRIES);
    }
  }
}

async function draftOne(row: ExamRequestRow): Promise<void> {
  const extraction = examRequests.readExtraction(row);

  if (!extraction) {
    examRequests.recordFailure(row.id, 'Extraction could not be read back.', false);
    return;
  }

  if (!extraction.patient_name) {
    examRequests.recordFailure(row.id, 'No patient name could be read from this email.', false);
    return;
  }

  // ── Patient ──
  const patient =
    patients.findMatchingPatient(extraction.email, extraction.patient_name) ??
    patients.createPatient({
      full_name: extraction.patient_name,
      email: extraction.email,
      phone: extraction.phone,
      date_of_birth: extraction.date_of_birth,
      health_card_number: extraction.health_card_number,
      health_card_version: extraction.health_card_version,
    });

  examRequests.linkPatient(row.id, patient.id);

  // Fill in details a returning patient's record was missing, without
  // overwriting anything already on file.
  const gaps: Record<string, string | null> = {};
  if (!patient.email && extraction.email) gaps.email = extraction.email;
  if (!patient.phone && extraction.phone) gaps.phone = extraction.phone;
  if (!patient.health_card_enc && extraction.health_card_number) {
    gaps.health_card_number = extraction.health_card_number;
    gaps.health_card_version = extraction.health_card_version;
  }
  if (Object.keys(gaps).length > 0) {
    patients.updatePatient(patient.id, gaps);
  }

  // ── Appointment ──
  const appointment = await resolveAppointment(row, extraction, patient.id);

  // ── Eligibility ──
  if (patient.health_card_enc || extraction.health_card_number) {
    await checkPatientEligibility({
      patientId: patient.id,
      appointmentId: appointment?.id ?? null,
      dateOfService: appointment?.starts_at?.slice(0, 10) ?? extraction.requested_date ?? undefined,
    });
  }

  // ── Invoice draft ──
  await draftInvoice(row, patient.id, appointment?.id ?? null);

  // ── Reminder draft ──
  if (appointment) {
    reminders.draftReminder(appointment, patients.getPatient(patient.id)!);
  }

  examRequests.setStatus(row.id, 'drafted');
}

async function resolveAppointment(
  row: ExamRequestRow,
  extraction: ReturnType<typeof examRequests.readExtraction>,
  patientId: string,
) {
  if (!extraction?.requested_date) return null;

  if (!isGoogleConnected()) return null;

  // The email states a wall-clock time ("Tuesday at 10"), while calendar
  // events carry absolute instants. Parsing without a zone designator
  // interprets it in the server's local timezone, which is the business's —
  // the app runs on a machine in the office. If that ever stops being
  // true, this is the line that needs an explicit zone conversion.
  const requestedAt = new Date(
    `${extraction.requested_date}T${extraction.requested_time ?? '00:00'}:00`,
  );
  if (Number.isNaN(requestedAt.getTime())) return null;

  // A day either side, so a request naming only a date still matches a
  // timed event on that day.
  const from = new Date(requestedAt.getTime() - 24 * 60 * 60 * 1000);
  const to = new Date(requestedAt.getTime() + 24 * 60 * 60 * 1000);

  const events = await listEvents(from, to);
  const event = matchEvent(
    events,
    { requestedAt, patientName: extraction.patient_name, patientEmail: extraction.email },
    // A request naming a time can be matched tightly; one naming only a
    // date has to accept anything that day.
    extraction.requested_time ? 60 * 60 * 1000 : 12 * 60 * 60 * 1000,
  );

  if (!event) return null;

  const appointment = appointments.upsertFromCalendarEvent(event, patientId);
  examRequests.linkAppointment(row.id, appointment.id);
  return appointment;
}

// ── Invoices ──

export function getInvoiceForRequest(examRequestId: string): WaveInvoiceRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM wave_invoices WHERE exam_request_id = ? ORDER BY rowid DESC LIMIT 1`)
    .get(examRequestId) as WaveInvoiceRow | undefined;
}

function examFeeAmount(): number {
  const value = Number(process.env.EXAM_FEE_AMOUNT);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Records the intended invoice locally without touching Wave.
 *
 * Creating it in Wave — even as a draft — is deferred to approval, so an
 * unreviewed misread never reaches the books.
 */
async function draftInvoice(row: ExamRequestRow, patientId: string, appointmentId: string | null) {
  if (getInvoiceForRequest(row.id)) return;

  const now = new Date().toISOString();
  const lineItems: InvoiceLineItemDraft[] = [
    {
      description: 'Comprehensive eye examination',
      quantity: 1,
      unitPrice: examFeeAmount(),
    },
  ];

  getDb()
    .prepare(
      `INSERT INTO wave_invoices (
         id, exam_request_id, appointment_id, patient_id, amount, currency,
         status, line_items, retry_count, created_at, updated_at
       ) VALUES (@id, @exam_request_id, @appointment_id, @patient_id, @amount, 'CAD', 'draft', @line_items, 0, @created_at, @updated_at)`,
    )
    .run({
      id: uuid(),
      exam_request_id: row.id,
      appointment_id: appointmentId,
      patient_id: patientId,
      amount: invoiceTotal(lineItems) || null,
      line_items: JSON.stringify(lineItems),
      created_at: now,
      updated_at: now,
    });
}

/** Sum of the drafted lines, rounded to cents. */
export function invoiceTotal(items: InvoiceLineItemDraft[]): number {
  return Math.round(items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0) * 100) / 100;
}

export function readLineItems(row: WaveInvoiceRow): InvoiceLineItemDraft[] {
  if (!row.line_items) {
    // Drafted before line items existed — present the stored total as
    // one line so it can still be edited.
    return [{ description: 'Comprehensive eye examination', quantity: 1, unitPrice: row.amount ?? 0 }];
  }
  try {
    const parsed = JSON.parse(row.line_items);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : [];
  } catch {
    return [];
  }
}

// ── Step 6: approval ──

/**
 * Commits an approved request: creates and sends the Wave invoice, and
 * releases the reminder.
 *
 * The only path in this file that is externally visible to a patient, and
 * it runs solely in response to an explicit operator action.
 */
export async function approveExamRequest(examRequestId: string): Promise<{
  invoice: { created: boolean; error: string | null };
  reminder: { scheduled: boolean; error: string | null };
}> {
  const row = examRequests.getExamRequest(examRequestId);
  if (!row) throw new Error('Exam request not found.');

  examRequests.setStatus(examRequestId, 'approved');
  audit({ action: 'invoice.create', entityType: 'exam_request', entityId: examRequestId });

  const invoice = await commitInvoice(row);
  const reminder = releaseReminder(row);

  if (invoice.error === null) {
    examRequests.setStatus(examRequestId, 'completed');
  } else {
    // Stays `approved` with the error recorded; retryApproved() below
    // re-attempts the commit on the next poll, backing off each time.
    examRequests.recordFailure(examRequestId, invoice.error, true, MAX_RETRIES);
  }

  return { invoice, reminder };
}

/**
 * Step 7 — re-attempt the commit for a request that reached `approved`
 * but whose Wave invoice failed transiently.
 *
 * Without this the request is stranded: the queue's other steps only
 * touch pre-approval statuses, and the approve route rejects anything not
 * `drafted`. commitInvoice() is resumable, so a retry never double-books.
 */
export async function retryApproved(): Promise<void> {
  for (const row of examRequests.listByStatus('approved')) {
    if (!row.last_error) continue; // approved and clean — waiting on nothing
    if (!isReadyForRetry(row)) continue;

    try {
      const invoice = await commitInvoice(row);
      if (invoice.error === null) {
        examRequests.setStatus(row.id, 'completed');
      } else {
        examRequests.recordFailure(row.id, invoice.error, true, MAX_RETRIES);
      }
    } catch (err) {
      const retryable =
        (err instanceof WaveAPIError && err.isRetryable) ||
        (err instanceof GoogleAuthError && err.isRetryable);
      examRequests.recordFailure(row.id, (err as Error).message, retryable, MAX_RETRIES);
    }
  }
}

/**
 * Creates the Wave invoice, approves it, and (if the patient has an
 * email) sends it.
 *
 * Resumable: a retry after a transient failure picks up where it stopped
 * rather than creating a second invoice. `approved`/`sent` means a prior
 * attempt already committed it — nothing to do.
 */
async function commitInvoice(row: ExamRequestRow): Promise<{ created: boolean; error: string | null }> {
  const invoiceRow = getInvoiceForRequest(row.id);
  if (!invoiceRow) return { created: false, error: null };
  if (invoiceRow.status === 'approved' || invoiceRow.status === 'sent') {
    return { created: true, error: null };
  }

  const businessId = process.env.WAVE_BUSINESS_ID;
  const incomeAccountId = process.env.WAVE_INCOME_ACCOUNT_ID;
  const productId = process.env.WAVE_SERVICE_PRODUCT_ID;

  if (!isWaveConfigured() || !businessId) {
    return { created: false, error: 'Wave is not configured.' };
  }
  if (!incomeAccountId && !productId) {
    return {
      created: false,
      error: 'Choose a service product or income account for invoices in Settings.',
    };
  }

  const patient = row.patient_id ? patients.getPatient(row.patient_id) : undefined;
  if (!patient) return { created: false, error: 'No patient is linked to this request.' };

  try {
    const token = await getWaveToken();

    const customer = await findOrCreateCustomer({
      businessId,
      name: patient.full_name,
      email: patient.email,
      phone: patient.phone,
      token,
    });

    if (!patient.wave_customer_id) {
      patients.setWaveCustomerId(patient.id, customer.id);
    }

    const appointment = row.appointment_id ? appointments.getAppointment(row.appointment_id) : undefined;
    const invoiceDate = (appointment?.starts_at ?? new Date().toISOString()).slice(0, 10);

    // Only create the invoice if a prior attempt didn't already.
    let invoiceId = invoiceRow.wave_invoice_id;
    if (!invoiceId) {
      const lines = readLineItems(invoiceRow);
      if (lines.length === 0) {
        const error = 'This invoice has no line items.';
        updateInvoiceRow(invoiceRow.id, { status: 'failed', last_error: error });
        return { created: false, error };
      }

      const created = await createInvoice({
        businessId,
        customerId: customer.id,
        invoiceDate,
        memo: appointment ? `Eye exam — ${invoiceDate}` : 'Eye exam',
        items: lines.map((line) => ({
          // Per-line overrides win; otherwise fall back to the business
          // default chosen in Settings.
          ...(line.productId
            ? { productId: line.productId }
            : line.accountId
              ? { accountId: line.accountId }
              : productId
                ? { productId }
                : { accountId: incomeAccountId! }),
          description: line.description,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          ...(line.salesTaxId
            ? { salesTaxId: line.salesTaxId }
            : process.env.WAVE_SALES_TAX_ID
              ? { salesTaxId: process.env.WAVE_SALES_TAX_ID }
              : {}),
        })),
        token,
      });

      if (!created.didSucceed || !created.invoiceId) {
        const error = created.errors.join('; ') || 'Wave rejected the invoice.';
        updateInvoiceRow(invoiceRow.id, { status: 'failed', last_error: error });
        return { created: false, error };
      }

      invoiceId = created.invoiceId;
      updateInvoiceRow(invoiceRow.id, {
        status: 'created',
        wave_invoice_id: created.invoiceId,
        wave_invoice_url: created.viewUrl,
        invoice_number: created.invoiceNumber,
        amount: created.total,
        last_error: null,
      });
    }

    const approved = await approveInvoice(invoiceId, token);
    if (approved.didSucceed) {
      updateInvoiceRow(invoiceRow.id, { status: 'approved', last_error: null });

      if (patient.email) {
        const sent = await sendInvoice({ invoiceId, to: patient.email, token });
        if (sent.didSucceed) {
          updateInvoiceRow(invoiceRow.id, { status: 'sent' });
          audit({ action: 'invoice.send', entityType: 'patient', entityId: patient.id });
        }
      }
    }

    return { created: true, error: null };
  } catch (err) {
    const message = (err as Error).message;
    updateInvoiceRow(invoiceRow.id, { status: 'failed', last_error: message });
    return { created: false, error: message };
  }
}

export function updateInvoiceRow(id: string, fields: Record<string, unknown>): void {
  const columns = Object.keys(fields);
  if (columns.length === 0) return;

  const assignments = columns.map((c) => `${c} = @${c}`).join(', ');
  getDb()
    .prepare(`UPDATE wave_invoices SET ${assignments}, updated_at = @updated_at WHERE id = @id`)
    .run({ ...fields, id, updated_at: new Date().toISOString() });
}

/**
 * Marks the drafted reminder ready to send.
 *
 * It still waits for its scheduled time — approval releases it, it does
 * not fire it early.
 */
function releaseReminder(row: ExamRequestRow): { scheduled: boolean; error: string | null } {
  if (!row.appointment_id) return { scheduled: false, error: null };

  const reminder = reminders.findForAppointment(row.appointment_id);
  if (!reminder) return { scheduled: false, error: null };

  return { scheduled: reminder.status === 'pending', error: null };
}

export function rejectExamRequest(examRequestId: string): void {
  const row = examRequests.getExamRequest(examRequestId);
  if (!row) return;

  examRequests.setStatus(examRequestId, 'rejected');

  // Nothing was sent, so the drafted reminder must not fire later.
  if (row.appointment_id) {
    const reminder = reminders.findForAppointment(row.appointment_id);
    if (reminder && reminder.status === 'pending') {
      reminders.cancelReminder(reminder.id);
    }
  }
}

// ── Reminder dispatch ──

/**
 * Sends reminders whose time has come.
 *
 * Only for requests the operator approved: a reminder attached to a
 * request still sitting in the inbox is skipped, so nothing reaches a
 * patient without review.
 */
export async function sendDueReminders(): Promise<number> {
  if (!isGoogleConnected()) return 0;

  let sent = 0;

  for (const reminder of reminders.listDue()) {
    if (!isReadyForRetry(reminder)) continue;

    const appointment = appointments.getAppointment(reminder.appointment_id);
    if (!appointment?.patient_id) {
      reminders.recordFailure(reminder.id, 'Reminder has no linked patient.', false);
      continue;
    }

    if (!isApproved(reminder.appointment_id)) continue;

    const patient = patients.getPatient(appointment.patient_id);
    if (!patient) {
      reminders.recordFailure(reminder.id, 'Linked patient no longer exists.', false);
      continue;
    }

    try {
      await reminders.sendReminder({ reminder, appointment, patient });
      sent++;
    } catch (err) {
      const retryable = err instanceof GoogleAuthError && err.isRetryable;
      reminders.recordFailure(reminder.id, (err as Error).message, retryable, MAX_RETRIES);
    }
  }

  return sent;
}

/** An appointment counts as approved once its request reached approval. */
function isApproved(appointmentId: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT status FROM exam_requests WHERE appointment_id = ?
       ORDER BY received_at DESC, rowid DESC LIMIT 1`,
    )
    .get(appointmentId) as { status: string } | undefined;

  // An appointment entered by hand has no exam request behind it; the
  // operator created it deliberately, so its reminder may send.
  if (!row) return true;

  return row.status === 'approved' || row.status === 'completed';
}

// ── Polling ──

const poller = makePoller({ name: 'exams-queue', intervalMs: POLL_INTERVAL_MS, pass: processQueue });

export const triggerQueue = poller.trigger;
export const startPolling = poller.start;
export const stopPolling = poller.stop;
