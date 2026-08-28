import { Router, Request, Response } from 'express';
import * as examRequests from '../practice/exam-requests.js';
import * as patientsService from '../practice/patients.js';
import * as appointmentsService from '../practice/appointments.js';
import * as remindersService from '../practice/reminders.js';
import * as queue from '../practice/queue.js';
import {
  checkPatientEligibility,
  latestCheckForAppointment,
  latestCheckForPatient,
  checksForPatient,
  toEligibilityDto,
} from '../practice/eligibility.js';
import { hcvMode } from '../integrations/ohip/index.js';
import { getDb } from '../db/db.js';
import { auditRequest, recentAuditEntries, verifyAuditChain } from '../platform/audit.js';
import { rateLimited } from '../platform/rate-limit.js';
import type { ExamRequestRow, WaveInvoiceRow, InvoiceLineItemDraft } from '../practice/types.js';

/**
 * The exam-request workflow API.
 *
 * Everything here is behind the auth gate. Responses go through the
 * patient DTO so a health card number can't escape by accident.
 */

function invoiceForRequest(examRequestId: string): WaveInvoiceRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM wave_invoices WHERE exam_request_id = ? ORDER BY rowid DESC LIMIT 1`)
    .get(examRequestId) as WaveInvoiceRow | undefined;
}

/** Validates an edited line item, returning an error string or null. */
function validateLineItems(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) {
    return 'An invoice needs at least one line item.';
  }

  for (const item of value as InvoiceLineItemDraft[]) {
    if (!item || typeof item.description !== 'string' || !item.description.trim()) {
      return 'Every line needs a description.';
    }
    if (typeof item.quantity !== 'number' || !Number.isFinite(item.quantity) || item.quantity <= 0) {
      return 'Quantity must be a number greater than zero.';
    }
    if (typeof item.unitPrice !== 'number' || !Number.isFinite(item.unitPrice) || item.unitPrice < 0) {
      return 'Unit price must be a number of zero or more.';
    }
  }

  return null;
}

/** Assembles the full card the Inbox screen renders. */
function toExamRequestDto(row: ExamRequestRow) {
  const patient = row.patient_id ? patientsService.getPatient(row.patient_id) : undefined;
  const appointment = row.appointment_id
    ? appointmentsService.getAppointment(row.appointment_id)
    : undefined;
  const eligibility = row.appointment_id
    ? latestCheckForAppointment(row.appointment_id)
    : row.patient_id
      ? latestCheckForPatient(row.patient_id)
      : undefined;
  const reminder = row.appointment_id
    ? remindersService.findForAppointment(row.appointment_id)
    : undefined;
  const invoice = invoiceForRequest(row.id);

  return {
    id: row.id,
    status: row.status,
    received_at: row.received_at,
    from_address: row.from_address,
    subject: row.subject,
    // The retained slice of the email body is PHI and is not inlined here.
    // It is fetched on demand through the audited /source route below.
    has_source: !!row.body_snippet,
    extraction: examRequests.toExtractionDto(examRequests.readExtraction(row)),
    last_error: row.last_error,
    retry_count: row.retry_count,
    patient: patient ? patientsService.toPatientDto(patient) : null,
    appointment: appointment ?? null,
    eligibility: eligibility ? toEligibilityDto(eligibility) : null,
    reminder: reminder
      ? {
          id: reminder.id,
          status: reminder.status,
          channel: reminder.channel,
          scheduled_for: reminder.scheduled_for,
          subject: reminder.subject,
          body: reminder.body,
          sent_at: reminder.sent_at,
          last_error: reminder.last_error,
        }
      : null,
    invoice: invoice
      ? {
          id: invoice.id,
          status: invoice.status,
          amount: invoice.amount,
          currency: invoice.currency,
          wave_invoice_id: invoice.wave_invoice_id,
          wave_invoice_url: invoice.wave_invoice_url,
          invoice_number: invoice.invoice_number,
          last_error: invoice.last_error,
          line_items: queue.readLineItems(invoice),
          // Only a draft can still be edited; once it exists in Wave the
          // authoritative copy lives there.
          editable: invoice.status === 'draft',
        }
      : null,
  };
}

export function practiceRoutes(): Router {
  const router = Router();

  // ── Exam requests ──

  // Declared before /:id so the literal path isn't swallowed by the
  // parameterised one.
  router.get('/exam-requests/counts', (_req: Request, res: Response): void => {
    res.json({
      counts: examRequests.statusCounts(),
      hcvMode: hcvMode(),
      gmailQueryConfigured: !!queue.gmailQuery(),
    });
  });

  // Each poll can fan out to Gmail + the Claude API for every new message.
  router.post('/exam-requests/poll', rateLimited('exam-poll', 10, 60_000), async (_req: Request, res: Response): Promise<void> => {
    try {
      const created = await queue.pollGmail();
      await queue.extractPending();
      await queue.draftPending();
      res.json({ success: true, created });
    } catch (err: any) {
      res.status(502).json({ error: err.message });
    }
  });

  router.get('/exam-requests', (req: Request, res: Response): void => {
    const rows = req.query.all === 'true' ? examRequests.listAll() : examRequests.listPending();
    res.json(rows.map(toExamRequestDto));
  });

  router.get('/exam-requests/:id', (req: Request, res: Response): void => {
    const row = examRequests.getExamRequest(req.params.id);
    if (!row) {
      res.status(404).json({ error: 'Exam request not found.' });
      return;
    }
    res.json(toExamRequestDto(row));
  });

  // ── GET /exam-requests/:id/source — the retained slice of the raw email ──
  // Separate from the DTO because it is PHI: reading it is audited, the
  // same way decrypting a health card number is.
  router.get('/exam-requests/:id/source', (req: Request, res: Response): void => {
    const row = examRequests.getExamRequest(req.params.id);
    if (!row) {
      res.status(404).json({ error: 'Exam request not found.' });
      return;
    }

    auditRequest(req, {
      action: 'exam_request.source_read',
      entityType: 'exam_request',
      entityId: row.id,
    });

    res.json({ body: examRequests.readBodySnippet(row) });
  });

  router.post('/exam-requests/:id/approve', async (req: Request, res: Response): Promise<void> => {
    const row = examRequests.getExamRequest(req.params.id);
    if (!row) {
      res.status(404).json({ error: 'Exam request not found.' });
      return;
    }

    if (row.status !== 'drafted') {
      res.status(400).json({
        error: `Only a drafted request can be approved (this one is "${row.status}").`,
      });
      return;
    }

    auditRequest(req, { action: 'invoice.create', entityType: 'exam_request', entityId: row.id });

    try {
      const result = await queue.approveExamRequest(row.id);
      res.json({ success: true, ...result, request: toExamRequestDto(examRequests.getExamRequest(row.id)!) });
    } catch (err: any) {
      res.status(502).json({ error: err.message });
    }
  });

  router.post('/exam-requests/:id/reject', (req: Request, res: Response): void => {
    if (!examRequests.getExamRequest(req.params.id)) {
      res.status(404).json({ error: 'Exam request not found.' });
      return;
    }
    queue.rejectExamRequest(req.params.id);
    res.json({ success: true });
  });

  router.post('/exam-requests/:id/retry', (req: Request, res: Response): void => {
    if (!examRequests.getExamRequest(req.params.id)) {
      res.status(404).json({ error: 'Exam request not found.' });
      return;
    }
    examRequests.retryExamRequest(req.params.id);
    queue.triggerQueue();
    res.json({ success: true });
  });

  router.delete('/exam-requests/:id', (req: Request, res: Response): void => {
    if (!examRequests.deleteExamRequest(req.params.id)) {
      res.status(404).json({ error: 'Exam request not found.' });
      return;
    }
    res.json({ success: true });
  });

  // ── Patients ──

  router.get('/patients', (_req: Request, res: Response): void => {
    res.json(patientsService.listPatients().map(patientsService.toPatientDto));
  });

  router.post('/patients', (req: Request, res: Response): void => {
    const { full_name } = req.body;
    if (!full_name || typeof full_name !== 'string') {
      res.status(400).json({ error: 'A patient name is required.' });
      return;
    }

    const patient = patientsService.createPatient(req.body);
    res.status(201).json(patientsService.toPatientDto(patient));
  });

  router.get('/patients/:id', (req: Request, res: Response): void => {
    const patient = patientsService.getPatient(req.params.id);
    if (!patient) {
      res.status(404).json({ error: 'Patient not found.' });
      return;
    }

    auditRequest(req, { action: 'patient.read', entityType: 'patient', entityId: patient.id });

    res.json({
      ...patientsService.toPatientDto(patient),
      appointments: appointmentsService.listForPatient(patient.id),
      eligibility_history: checksForPatient(patient.id).map(toEligibilityDto),
    });
  });

  router.put('/patients/:id', (req: Request, res: Response): void => {
    const updated = patientsService.updatePatient(req.params.id, req.body);
    if (!updated) {
      res.status(404).json({ error: 'Patient not found.' });
      return;
    }
    res.json(patientsService.toPatientDto(updated));
  });

  router.delete('/patients/:id', (req: Request, res: Response): void => {
    if (!patientsService.deletePatient(req.params.id)) {
      res.status(404).json({ error: 'Patient not found.' });
      return;
    }
    res.json({ success: true });
  });

  router.post('/patients/:id/check-eligibility', rateLimited('eligibility', 30, 5 * 60_000), async (req: Request, res: Response): Promise<void> => {
    if (!patientsService.getPatient(req.params.id)) {
      res.status(404).json({ error: 'Patient not found.' });
      return;
    }

    const outcome = await checkPatientEligibility({
      patientId: req.params.id,
      appointmentId: req.body?.appointmentId ?? null,
      dateOfService: req.body?.dateOfService,
      force: req.body?.force === true || req.query.force === 'true',
    });

    res.json(outcome);
  });

  // ── Schedule ──

  router.get('/appointments', (req: Request, res: Response): void => {
    const rows =
      req.query.from && req.query.to
        ? appointmentsService.listBetween(String(req.query.from), String(req.query.to))
        : appointmentsService.listUpcoming();

    res.json(
      rows.map((appointment) => {
        const patient = appointment.patient_id
          ? patientsService.getPatient(appointment.patient_id)
          : undefined;
        const eligibility = latestCheckForAppointment(appointment.id);

        return {
          ...appointment,
          patient: patient ? patientsService.toPatientDto(patient) : null,
          eligibility: eligibility ? toEligibilityDto(eligibility) : null,
        };
      }),
    );
  });

  router.post('/appointments/:id/check-eligibility', rateLimited('eligibility', 30, 5 * 60_000), async (req: Request, res: Response): Promise<void> => {
    const appointment = appointmentsService.getAppointment(req.params.id);
    if (!appointment) {
      res.status(404).json({ error: 'Appointment not found.' });
      return;
    }
    if (!appointment.patient_id) {
      res.status(400).json({ error: 'No patient is linked to this appointment.' });
      return;
    }

    const outcome = await checkPatientEligibility({
      patientId: appointment.patient_id,
      appointmentId: appointment.id,
      dateOfService: appointment.starts_at.slice(0, 10),
      force: req.body?.force === true || req.query.force === 'true',
    });

    res.json(outcome);
  });

  router.post('/appointments/:id/link-patient', (req: Request, res: Response): void => {
    const appointment = appointmentsService.getAppointment(req.params.id);
    if (!appointment) {
      res.status(404).json({ error: 'Appointment not found.' });
      return;
    }

    const { patientId } = req.body;
    if (!patientId || !patientsService.getPatient(patientId)) {
      res.status(400).json({ error: 'A valid patient id is required.' });
      return;
    }

    appointmentsService.linkPatient(appointment.id, patientId);
    res.json({ success: true });
  });

  // ── PUT /api/practice/exam-requests/:id/invoice — edit the draft ──
  router.put('/exam-requests/:id/invoice', (req: Request, res: Response): void => {
    const row = examRequests.getExamRequest(req.params.id);
    if (!row) {
      res.status(404).json({ error: 'Exam request not found.' });
      return;
    }

    const invoice = queue.getInvoiceForRequest(row.id);
    if (!invoice) {
      res.status(404).json({ error: 'No invoice has been drafted for this request.' });
      return;
    }

    if (invoice.status !== 'draft') {
      res.status(400).json({
        error: 'This invoice has already been created in Wave and can no longer be edited here.',
      });
      return;
    }

    const { line_items } = req.body;
    const problem = validateLineItems(line_items);
    if (problem) {
      res.status(400).json({ error: problem });
      return;
    }

    const items = line_items as InvoiceLineItemDraft[];
    queue.updateInvoiceRow(invoice.id, {
      line_items: JSON.stringify(items),
      amount: queue.invoiceTotal(items),
      last_error: null,
    });

    res.json({ success: true, request: toExamRequestDto(examRequests.getExamRequest(row.id)!) });
  });

  // ── POST /api/practice/appointments — enter one by hand ──
  router.post('/appointments', (req: Request, res: Response): void => {
    const { startsAt, endsAt, title, location, patientId } = req.body;

    if (!startsAt || Number.isNaN(new Date(startsAt).getTime())) {
      res.status(400).json({ error: 'A valid start date and time is required.' });
      return;
    }

    if (endsAt && new Date(endsAt).getTime() < new Date(startsAt).getTime()) {
      res.status(400).json({ error: 'The end time cannot be before the start time.' });
      return;
    }

    if (patientId && !patientsService.getPatient(patientId)) {
      res.status(400).json({ error: 'That patient does not exist.' });
      return;
    }

    const appointment = appointmentsService.createAppointment({
      patientId: patientId || null,
      startsAt: new Date(startsAt).toISOString(),
      endsAt: endsAt ? new Date(endsAt).toISOString() : null,
      title: title || null,
      location: location || null,
      // Not from calendar sync, so a later poll must not treat it as a
      // stale Google event and overwrite it.
      source: 'manual',
    });

    res.status(201).json(appointment);
  });

  router.delete('/appointments/:id', (req: Request, res: Response): void => {
    if (!appointmentsService.deleteAppointment(req.params.id)) {
      res.status(404).json({ error: 'Appointment not found.' });
      return;
    }
    res.json({ success: true });
  });

  // ── GET /api/practice/audit — the access trail ──
  router.get('/audit', (req: Request, res: Response): void => {
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    res.json(recentAuditEntries(limit));
  });

  // ── GET /api/practice/audit/verify — is the hash chain intact? ──
  router.get('/audit/verify', (_req: Request, res: Response): void => {
    res.json(verifyAuditChain());
  });

  return router;
}
