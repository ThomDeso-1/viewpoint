import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { setupTestApp, type TestContext } from '../helpers/testApp.js';
import { installFetchMock, jsonResponse } from '../helpers/fetchMock.js';

/**
 * The automation queue, end to end with every external service mocked at
 * the fetch boundary.
 *
 * The property that matters most here: steps 1–5 run unattended, but
 * nothing reaches a patient or the books until the operator approves.
 */

function claudeBatch(patients: Record<string, unknown>[]) {
  return jsonResponse(200, {
    content: [{ type: 'text', text: JSON.stringify(patients) }],
  });
}

const FULL_EXTRACTION = {
  patient_name: 'Ada Lovelace',
  email: 'ada@example.com',
  phone: '555-0100',
  date_of_birth: '1990-01-01',
  health_card_number: '1111111111',
  health_card_version: 'AB',
  requested_date: '2026-09-01',
  requested_time: '10:00',
  reason: 'Annual eye exam',
  confidence: 0.95,
};

describe('exams queue', () => {
  let ctx: TestContext;
  let sourceDir: string;
  let queue: typeof import('../../server/exams/queue.js');
  let examRequests: typeof import('../../server/exams/exam-requests.js');
  let processedFiles: typeof import('../../server/exams/processed-files.js');
  let patients: typeof import('../../server/exams/patients.js');
  let store: typeof import('../../server/platform/oauth-store.js');

  beforeEach(async () => {
    sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-src-'));
    ctx = await setupTestApp({
      CLAUDE_API_KEY: 'test-claude-key',
      EXAM_REQUEST_SOURCE_DIR: sourceDir,
    });
    queue = await import('../../server/exams/queue.js');
    examRequests = await import('../../server/exams/exam-requests.js');
    processedFiles = await import('../../server/exams/processed-files.js');
    patients = await import('../../server/exams/patients.js');
    store = await import('../../server/platform/oauth-store.js');

    store.saveTokens('google', {
      accessToken: 'google-token',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    ctx.teardown();
    fs.rmSync(sourceDir, { recursive: true, force: true });
  });

  const writeSource = (name: string, body = 'patient file contents') => {
    const full = path.join(sourceDir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
    return full;
  };

  describe('folder scanning', () => {
    it('creates one request per patient in a file', async () => {
      writeSource('bookings.csv');
      const mock = installFetchMock();
      mock.mockResolvedValueOnce(
        claudeBatch([
          FULL_EXTRACTION,
          { ...FULL_EXTRACTION, patient_name: 'Grace Hopper', email: 'grace@example.com' },
        ]),
      );

      expect(await queue.scanSourceFolder()).toBe(2);

      const rows = examRequests.listByStatus('extracted');
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => examRequests.readExtraction(r)?.patient_name).sort()).toEqual([
        'Ada Lovelace',
        'Grace Hopper',
      ]);
      expect(rows.every((r) => r.source === 'file')).toBe(true);
    });

    it('does not re-read a file whose contents have not changed', async () => {
      writeSource('bookings.csv');
      const mock = installFetchMock();
      mock.mockResolvedValueOnce(claudeBatch([FULL_EXTRACTION]));
      expect(await queue.scanSourceFolder()).toBe(1);

      // No new Claude call is queued — a second read would throw.
      expect(await queue.scanSourceFolder()).toBe(0);
      expect(examRequests.listAll()).toHaveLength(1);
    });

    it('re-reads a file after its contents change', async () => {
      writeSource('bookings.csv', 'first version');
      const mock = installFetchMock();
      mock.mockResolvedValueOnce(claudeBatch([FULL_EXTRACTION]));
      await queue.scanSourceFolder();

      writeSource('bookings.csv', 'second version, now with two patients');
      mock.mockResolvedValueOnce(
        claudeBatch([FULL_EXTRACTION, { ...FULL_EXTRACTION, patient_name: 'Alan Turing' }]),
      );
      expect(await queue.scanSourceFolder()).toBe(2);
      expect(examRequests.listAll()).toHaveLength(3);
    });

    it('does nothing when no folder is configured', async () => {
      delete process.env.EXAM_REQUEST_SOURCE_DIR;
      const mock = installFetchMock();

      expect(await queue.scanSourceFolder()).toBe(0);
      expect(mock).not.toHaveBeenCalled();
    });

    it('does nothing without a Claude key', async () => {
      writeSource('bookings.csv');
      delete process.env.CLAUDE_API_KEY;
      const mock = installFetchMock();

      expect(await queue.scanSourceFolder()).toBe(0);
      expect(mock).not.toHaveBeenCalled();
    });

    it('survives a bad folder path without throwing', async () => {
      process.env.EXAM_REQUEST_SOURCE_DIR = path.join(sourceDir, 'does-not-exist');
      installFetchMock();

      await expect(queue.scanSourceFolder()).resolves.toBe(0);
    });

    it('records a file that fails to parse and backs off instead of retrying every pass', async () => {
      writeSource('broken.csv');
      const mock = installFetchMock();
      mock.mockResolvedValueOnce(jsonResponse(200, { content: [{ type: 'text', text: 'not json' }] }));

      expect(await queue.scanSourceFolder()).toBe(0);

      const record = processedFiles.get('broken.csv')!;
      expect(record.status).toBe('error');
      expect(record.retry_count).toBe(1);
      expect(examRequests.listAll()).toHaveLength(0);

      // Immediately re-scanning does not call Claude again (still backing off).
      expect(await queue.scanSourceFolder()).toBe(0);
      expect(mock.mock.calls).toHaveLength(1);
    });

    it('retries a file after a transient Claude failure', async () => {
      writeSource('bookings.csv');
      const mock = installFetchMock();
      mock.mockResolvedValueOnce(jsonResponse(529, {}));
      await queue.scanSourceFolder();
      expect(processedFiles.get('bookings.csv')!.status).toBe('error');

      // Make it due for another attempt.
      const { getDb } = await import('../../server/db/db.js');
      getDb()
        .prepare(`UPDATE processed_source_files SET updated_at = ? WHERE relative_path = ?`)
        .run(new Date(Date.now() - 60_000).toISOString(), 'bookings.csv');

      mock.mockResolvedValueOnce(claudeBatch([FULL_EXTRACTION]));
      expect(await queue.scanSourceFolder()).toBe(1);
      expect(processedFiles.get('bookings.csv')!.status).toBe('ok');
    });

    it('parks a low-confidence row for review instead of drafting it', async () => {
      writeSource('bookings.csv');
      const mock = installFetchMock();
      mock.mockResolvedValueOnce(claudeBatch([{ ...FULL_EXTRACTION, confidence: 0.1 }]));

      await queue.scanSourceFolder();

      const row = examRequests.listAll()[0];
      expect(row.status).toBe('needsAttention');
      expect(row.last_error).toContain('Low confidence');
    });
  });

  describe('drafting', () => {
    async function seedExtracted(extraction: Record<string, unknown> = FULL_EXTRACTION) {
      writeSource('bookings.csv');
      const mock = installFetchMock();
      mock.mockResolvedValueOnce(claudeBatch([extraction]));
      await queue.scanSourceFolder();
      return mock;
    }

    it('creates the patient, checks eligibility, and drafts an invoice and reminder', async () => {
      const mock = await seedExtracted();
      mock.mockResolvedValueOnce(
        jsonResponse(200, {
          items: [
            {
              id: 'evt-1',
              summary: 'Exam — Ada Lovelace',
              start: { dateTime: new Date('2026-09-01T10:00:00').toISOString() },
              end: { dateTime: new Date('2026-09-01T10:30:00').toISOString() },
              status: 'confirmed',
              attendees: [{ email: 'ada@example.com' }],
            },
          ],
        }),
      );

      await queue.draftPending();

      const row = examRequests.listAll()[0];
      expect(row.status).toBe('drafted');
      expect(row.patient_id).toBeTruthy();
      expect(row.appointment_id).toBeTruthy();

      const dto = await request(ctx.app).get(`/api/exams/exam-requests/${row.id}`);
      expect(dto.body.patient.full_name).toBe('Ada Lovelace');
      expect(dto.body.eligibility.is_eligible).toBe(true);
      expect(dto.body.eligibility.mode).toBe('mock');
      expect(dto.body.reminder.status).toBe('pending');
      expect(dto.body.invoice.status).toBe('draft');
      expect(dto.body.source).toBe('file');
    });

    it('never contacts Wave while drafting', async () => {
      const mock = await seedExtracted();
      mock.mockResolvedValueOnce(jsonResponse(200, { items: [] }));

      await queue.draftPending();

      const waveCalls = mock.mock.calls.filter((c) => String(c[0]).includes('waveapps.com'));
      expect(waveCalls).toHaveLength(0);
    });

    it('stores the health card encrypted, never in the request row', async () => {
      const mock = await seedExtracted();
      mock.mockResolvedValueOnce(jsonResponse(200, { items: [] }));

      await queue.draftPending();

      const row = examRequests.listAll()[0];
      expect(JSON.stringify(row)).not.toContain('1111111111');
      expect(row.extracted_json!.startsWith('v1:')).toBe(true);
      expect(row.body_snippet!.startsWith('v1:')).toBe(true);
      expect(examRequests.readExtraction(row)!.health_card_number).toBe('1111111111');
      expect(patients.readHealthCard(row.patient_id!, 'test')).toBe('1111111111');
    });

    it('reuses an existing patient rather than creating a duplicate', async () => {
      const existing = patients.createPatient({ full_name: 'Ada Lovelace', email: 'ada@example.com' });

      const mock = await seedExtracted();
      mock.mockResolvedValueOnce(jsonResponse(200, { items: [] }));
      await queue.draftPending();

      expect(patients.listPatients()).toHaveLength(1);
      expect(examRequests.listAll()[0].patient_id).toBe(existing.id);
    });

    it('fills gaps on an existing record without overwriting what is there', async () => {
      const existing = patients.createPatient({
        full_name: 'Ada Lovelace',
        email: 'ada@example.com',
        phone: '555-EXISTING',
      });

      const mock = await seedExtracted();
      mock.mockResolvedValueOnce(jsonResponse(200, { items: [] }));
      await queue.draftPending();

      const after = patients.getPatient(existing.id)!;
      expect(after.phone).toBe('555-EXISTING');
      expect(patients.readHealthCard(existing.id, 'test')).toBe('1111111111');
    });

    it('records the appointment from the file when no calendar event matches', async () => {
      const mock = await seedExtracted();
      mock.mockResolvedValueOnce(jsonResponse(200, { items: [] }));

      await queue.draftPending();

      const row = examRequests.listAll()[0];
      expect(row.status).toBe('drafted');
      expect(row.appointment_id).toBeTruthy();

      const appointments = await import('../../server/exams/appointments.js');
      const appt = appointments.getAppointment(row.appointment_id!)!;
      expect(appt.source).toBe('file');
      expect(appt.google_event_id).toBeNull();
      expect(appt.starts_at.slice(0, 10)).toBe('2026-09-01');
    });

    it('records a local appointment even when Google is not connected', async () => {
      store.disconnect('google');
      await seedExtracted();

      await queue.draftPending();

      const row = examRequests.listAll()[0];
      expect(row.status).toBe('drafted');
      expect(row.appointment_id).toBeTruthy();
    });

    it('parks a request with no patient name', async () => {
      await seedExtracted({ ...FULL_EXTRACTION, patient_name: null });

      await queue.draftPending();

      const row = examRequests.listAll()[0];
      expect(row.status).toBe('needsAttention');
      expect(row.last_error).toContain('No patient name');
    });
  });

  describe('approval', () => {
    async function seedDrafted() {
      writeSource('bookings.csv');
      const mock = installFetchMock();
      mock.mockResolvedValueOnce(claudeBatch([FULL_EXTRACTION]));
      await queue.scanSourceFolder();

      mock.mockResolvedValueOnce(
        jsonResponse(200, {
          items: [
            {
              id: 'evt-1',
              summary: 'Exam — Ada Lovelace',
              start: { dateTime: new Date('2026-09-01T10:00:00').toISOString() },
              end: { dateTime: new Date('2026-09-01T10:30:00').toISOString() },
              status: 'confirmed',
            },
          ],
        }),
      );
      await queue.draftPending();

      return { mock, row: examRequests.listAll()[0] };
    }

    it('reports a clear error when Wave is not configured', async () => {
      const { row } = await seedDrafted();

      const result = await queue.approveExamRequest(row.id);
      expect(result.invoice.error).toContain('Wave is not configured');
    });

    it('writes a file-sourced appointment to Google Calendar on approval', async () => {
      writeSource('bookings.csv');
      const mock = installFetchMock();
      mock.mockResolvedValueOnce(claudeBatch([FULL_EXTRACTION]));
      await queue.scanSourceFolder();

      // No calendar match, so the appointment came from the file.
      mock.mockResolvedValueOnce(jsonResponse(200, { items: [] }));
      await queue.draftPending();
      const row = examRequests.listAll()[0];

      // Approve: Wave isn't configured (invoice fails) but the calendar
      // event is still created.
      mock.mockResolvedValueOnce(jsonResponse(200, { id: 'new-evt-1', status: 'confirmed', start: { dateTime: new Date('2026-09-01T10:00:00').toISOString() } }));
      await queue.approveExamRequest(row.id);

      const createCall = mock.mock.calls.find(
        (c) => String(c[0]).includes('/events') && (c[1] as RequestInit)?.method === 'POST',
      );
      expect(createCall).toBeTruthy();

      const appointments = await import('../../server/exams/appointments.js');
      const appt = appointments.getAppointment(examRequests.getExamRequest(row.id)!.appointment_id!)!;
      expect(appt.google_event_id).toBe('new-evt-1');
      expect(appt.source).toBe('google');
    });

    it('creates, approves and sends the invoice once approved', async () => {
      process.env.WAVE_ACCESS_TOKEN = 'wave-token';
      process.env.WAVE_BUSINESS_ID = 'biz-1';
      process.env.WAVE_INCOME_ACCOUNT_ID = 'income-1';

      const { mock, row } = await seedDrafted();

      mock
        .mockResolvedValueOnce(jsonResponse(200, { data: { business: { customers: { pageInfo: { currentPage: 1, totalPages: 1 }, edges: [] } } } }))
        .mockResolvedValueOnce(
          jsonResponse(200, {
            data: { customerCreate: { didSucceed: true, customer: { id: 'cust-1', name: 'Ada', email: 'ada@example.com' } } },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse(200, {
            data: {
              invoiceCreate: {
                didSucceed: true,
                invoice: { id: 'inv-1', invoiceNumber: '1001', viewUrl: 'https://wave/inv-1', total: { value: 120 } },
              },
            },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse(200, { data: { invoiceApprove: { didSucceed: true, invoice: { id: 'inv-1' } } } }),
        )
        .mockResolvedValueOnce(jsonResponse(200, { data: { invoiceSend: { didSucceed: true } } }));

      const result = await queue.approveExamRequest(row.id);

      expect(result.invoice.created).toBe(true);
      expect(result.invoice.error).toBeNull();
      expect(examRequests.getExamRequest(row.id)!.status).toBe('completed');

      const dto = await request(ctx.app).get(`/api/exams/exam-requests/${row.id}`);
      expect(dto.body.invoice.status).toBe('sent');
      expect(dto.body.invoice.wave_invoice_id).toBe('inv-1');
    });

    it('records a Wave rejection instead of claiming success', async () => {
      process.env.WAVE_ACCESS_TOKEN = 'wave-token';
      process.env.WAVE_BUSINESS_ID = 'biz-1';
      process.env.WAVE_INCOME_ACCOUNT_ID = 'income-1';

      const { mock, row } = await seedDrafted();

      mock
        .mockResolvedValueOnce(jsonResponse(200, { data: { business: { customers: { pageInfo: { currentPage: 1, totalPages: 1 }, edges: [] } } } }))
        .mockResolvedValueOnce(
          jsonResponse(200, { data: { customerCreate: { didSucceed: true, customer: { id: 'c1', name: 'Ada', email: null } } } }),
        )
        .mockResolvedValueOnce(
          jsonResponse(200, {
            data: {
              invoiceCreate: {
                didSucceed: false,
                inputErrors: [{ path: 'items', message: 'is required', code: 'REQUIRED' }],
              },
            },
          }),
        );

      const result = await queue.approveExamRequest(row.id);

      expect(result.invoice.created).toBe(false);
      expect(result.invoice.error).toContain('items: is required');
      expect(examRequests.getExamRequest(row.id)!.status).not.toBe('completed');
    });

    it('rejecting cancels the drafted reminder so it never sends', async () => {
      const { row } = await seedDrafted();
      const reminders = await import('../../server/exams/reminders.js');

      queue.rejectExamRequest(row.id);

      expect(examRequests.getExamRequest(row.id)!.status).toBe('rejected');
      expect(reminders.findForAppointment(row.appointment_id!)!.status).toBe('cancelled');
    });

    it('recovers a request stranded in "approved" by a transient Wave failure (P1-11)', async () => {
      process.env.WAVE_ACCESS_TOKEN = 'wave-token';
      process.env.WAVE_BUSINESS_ID = 'biz-1';
      process.env.WAVE_INCOME_ACCOUNT_ID = 'income-1';

      const { mock, row } = await seedDrafted();

      mock.mockResolvedValueOnce(jsonResponse(500, {}));
      const first = await queue.approveExamRequest(row.id);
      expect(first.invoice.error).toBeTruthy();
      expect(examRequests.getExamRequest(row.id)!.status).toBe('approved');

      const { getDb } = await import('../../server/db/db.js');
      getDb()
        .prepare(`UPDATE exam_requests SET updated_at = ? WHERE id = ?`)
        .run(new Date(Date.now() - 60_000).toISOString(), row.id);

      mock
        .mockResolvedValueOnce(jsonResponse(200, { data: { business: { customers: { pageInfo: { currentPage: 1, totalPages: 1 }, edges: [] } } } }))
        .mockResolvedValueOnce(jsonResponse(200, { data: { customerCreate: { didSucceed: true, customer: { id: 'c1', name: 'Ada', email: 'ada@example.com' } } } }))
        .mockResolvedValueOnce(jsonResponse(200, { data: { invoiceCreate: { didSucceed: true, invoice: { id: 'inv-1', invoiceNumber: '1001', viewUrl: 'https://wave/inv-1', total: { value: 120 } } } } }))
        .mockResolvedValueOnce(jsonResponse(200, { data: { invoiceApprove: { didSucceed: true, invoice: { id: 'inv-1' } } } }))
        .mockResolvedValueOnce(jsonResponse(200, { data: { invoiceSend: { didSucceed: true } } }));

      await queue.retryApproved();

      expect(examRequests.getExamRequest(row.id)!.status).toBe('completed');
      const dto = await request(ctx.app).get(`/api/exams/exam-requests/${row.id}`);
      expect(dto.body.invoice.status).toBe('sent');
      expect(dto.body.invoice.wave_invoice_id).toBe('inv-1');
    });
  });

  describe('reminder dispatch', () => {
    async function seedDueReminder() {
      const soon = new Date(Date.now() + 60 * 60 * 1000);
      const pad = (n: number) => String(n).padStart(2, '0');
      const day = `${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}`;
      const time = `${pad(soon.getHours())}:${pad(soon.getMinutes())}`;

      writeSource('bookings.csv');
      const mock = installFetchMock();
      mock.mockResolvedValueOnce(
        claudeBatch([{ ...FULL_EXTRACTION, requested_date: day, requested_time: time }]),
      );
      await queue.scanSourceFolder();

      mock.mockResolvedValueOnce(
        jsonResponse(200, {
          items: [
            {
              id: 'evt-1',
              summary: 'Exam — Ada Lovelace',
              start: { dateTime: soon.toISOString() },
              end: { dateTime: new Date(soon.getTime() + 30 * 60 * 1000).toISOString() },
              status: 'confirmed',
            },
          ],
        }),
      );
      await queue.draftPending();

      const row = examRequests.listAll()[0];
      expect(row.appointment_id).toBeTruthy();
      return { mock, row };
    }

    it('sends the reminder once the request has been approved', async () => {
      const { mock, row } = await seedDueReminder();

      await queue.approveExamRequest(row.id);

      mock.mockResolvedValueOnce(jsonResponse(200, { id: 'sent-1' }));
      expect(await queue.sendDueReminders()).toBe(1);

      const reminders = await import('../../server/exams/reminders.js');
      const reminder = reminders.findForAppointment(row.appointment_id!)!;
      expect(reminder.status).toBe('sent');
      expect(reminder.provider_message_id).toBe('sent-1');

      const sendCall = mock.mock.calls.find((c) => String(c[0]).includes('/messages/send'))!;
      const payload = JSON.parse((sendCall[1] as RequestInit).body as string);
      const mime = Buffer.from(payload.raw, 'base64url').toString();
      expect(mime).toContain('To: ada@example.com');
      expect(mime).toContain('reminder');
    });

    it('does not send the same reminder twice', async () => {
      const { mock, row } = await seedDueReminder();
      await queue.approveExamRequest(row.id);

      mock.mockResolvedValueOnce(jsonResponse(200, { id: 'sent-1' }));
      expect(await queue.sendDueReminders()).toBe(1);
      expect(await queue.sendDueReminders()).toBe(0);
    });

    it('retries a transient send failure and keeps the reminder pending', async () => {
      const { mock, row } = await seedDueReminder();
      await queue.approveExamRequest(row.id);

      mock.mockResolvedValueOnce(jsonResponse(503, {}));
      expect(await queue.sendDueReminders()).toBe(0);

      const reminders = await import('../../server/exams/reminders.js');
      const reminder = reminders.findForAppointment(row.appointment_id!)!;
      expect(reminder.status).toBe('pending');
      expect(reminder.retry_count).toBe(1);
      expect(reminder.last_error).toBeTruthy();
    });

    it('gives up on a reminder whose connection is broken', async () => {
      const { mock, row } = await seedDueReminder();
      await queue.approveExamRequest(row.id);

      mock.mockResolvedValueOnce(jsonResponse(401, {}));
      expect(await queue.sendDueReminders()).toBe(0);

      const reminders = await import('../../server/exams/reminders.js');
      expect(reminders.findForAppointment(row.appointment_id!)!.status).toBe('failed');
    });

    it('never sends a reminder for a rejected request', async () => {
      const { mock, row } = await seedDueReminder();
      queue.rejectExamRequest(row.id);

      const callsBefore = mock.mock.calls.length;
      expect(await queue.sendDueReminders()).toBe(0);
      expect(mock.mock.calls.length).toBe(callsBefore);
    });

    it('holds back reminders for requests still awaiting approval', async () => {
      writeSource('bookings.csv');
      const mock = installFetchMock();
      mock.mockResolvedValueOnce(claudeBatch([{ ...FULL_EXTRACTION, requested_date: '2026-09-01' }]));
      await queue.scanSourceFolder();

      mock.mockResolvedValueOnce(
        jsonResponse(200, {
          items: [
            {
              id: 'evt-1',
              summary: 'Exam — Ada Lovelace',
              start: { dateTime: new Date('2026-09-01T10:00:00').toISOString() },
              end: { dateTime: new Date('2026-09-01T10:30:00').toISOString() },
              status: 'confirmed',
            },
          ],
        }),
      );
      await queue.draftPending();

      const callsBefore = mock.mock.calls.length;
      const sent = await queue.sendDueReminders();

      expect(sent).toBe(0);
      expect(mock.mock.calls.length).toBe(callsBefore);
    });
  });
});
