import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestApp, type TestContext } from '../helpers/testApp.js';
import { installFetchMock, jsonResponse } from '../helpers/fetchMock.js';

/**
 * The automation queue, end to end with every external service mocked at
 * the fetch boundary.
 *
 * The property that matters most here: steps 1–5 run unattended, but
 * nothing reaches a patient or the books until the operator approves.
 */

const b64 = (s: string) => Buffer.from(s).toString('base64url');

function gmailListResponse(ids: string[]) {
  return jsonResponse(200, { messages: ids.map((id) => ({ id, threadId: `t-${id}` })) });
}

function gmailMessageResponse(opts: {
  id: string;
  from?: string;
  subject?: string;
  body: string;
}) {
  return jsonResponse(200, {
    id: opts.id,
    threadId: `t-${opts.id}`,
    internalDate: String(Date.parse('2026-08-20T09:00:00Z')),
    snippet: opts.body.slice(0, 50),
    payload: {
      headers: [
        { name: 'From', value: opts.from ?? 'ada@example.com' },
        { name: 'Subject', value: opts.subject ?? 'Eye exam request' },
      ],
      mimeType: 'text/plain',
      body: { data: b64(opts.body) },
    },
  });
}

function claudeResponse(extraction: Record<string, unknown>) {
  return jsonResponse(200, {
    content: [{ type: 'text', text: JSON.stringify(extraction) }],
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

describe('practice queue', () => {
  let ctx: TestContext;
  let queue: typeof import('../../server/practice/queue.js');
  let examRequests: typeof import('../../server/practice/exam-requests.js');
  let patients: typeof import('../../server/practice/patients.js');
  let store: typeof import('../../server/platform/oauth-store.js');

  beforeEach(async () => {
    ctx = await setupTestApp({
      CLAUDE_API_KEY: 'test-claude-key',
      GMAIL_EXAM_REQUEST_QUERY: 'label:exam-requests',
    });
    queue = await import('../../server/practice/queue.js');
    examRequests = await import('../../server/practice/exam-requests.js');
    patients = await import('../../server/practice/patients.js');
    store = await import('../../server/platform/oauth-store.js');

    store.saveTokens('google', {
      accessToken: 'google-token',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    ctx.teardown();
  });

  describe('Gmail polling', () => {
    it('creates one request per new message', async () => {
      const mock = installFetchMock();
      mock
        .mockResolvedValueOnce(gmailListResponse(['m1', 'm2']))
        .mockResolvedValueOnce(gmailMessageResponse({ id: 'm1', body: 'Please book me in.' }))
        .mockResolvedValueOnce(gmailMessageResponse({ id: 'm2', body: 'Exam please.' }));

      expect(await queue.pollGmail()).toBe(2);
      expect(examRequests.listByStatus('received')).toHaveLength(2);
    });

    it('does not duplicate a message seen on an earlier poll', async () => {
      const mock = installFetchMock();
      mock
        .mockResolvedValueOnce(gmailListResponse(['m1']))
        .mockResolvedValueOnce(gmailMessageResponse({ id: 'm1', body: 'Book me.' }));
      await queue.pollGmail();

      // The poll window overlaps deliberately, so the same id comes back.
      mock.mockResolvedValueOnce(gmailListResponse(['m1']));
      expect(await queue.pollGmail()).toBe(0);

      expect(examRequests.listAll()).toHaveLength(1);
    });

    it('does nothing when no query is configured', async () => {
      delete process.env.GMAIL_EXAM_REQUEST_QUERY;
      const mock = installFetchMock();

      expect(await queue.pollGmail()).toBe(0);
      expect(mock).not.toHaveBeenCalled();
    });

    it('does nothing when Google is not connected', async () => {
      store.disconnect('google');
      const mock = installFetchMock();

      expect(await queue.pollGmail()).toBe(0);
      expect(mock).not.toHaveBeenCalled();
    });

    it('survives a Gmail outage without losing its place', async () => {
      const mock = installFetchMock();
      mock.mockResolvedValue(jsonResponse(503, {}));

      await expect(queue.pollGmail()).resolves.toBe(0);
    });
  });

  describe('extraction', () => {
    async function seedMessage(body = 'Please book an exam.') {
      const mock = installFetchMock();
      mock
        .mockResolvedValueOnce(gmailListResponse(['m1']))
        .mockResolvedValueOnce(gmailMessageResponse({ id: 'm1', body }));
      await queue.pollGmail();
      return mock;
    }

    it('parses an email into structured details', async () => {
      const mock = await seedMessage();
      mock.mockResolvedValueOnce(claudeResponse(FULL_EXTRACTION));

      await queue.extractPending();

      const row = examRequests.listByStatus('extracted')[0];
      expect(row).toBeDefined();
      expect(examRequests.readExtraction(row)?.patient_name).toBe('Ada Lovelace');
    });

    it('parks a low-confidence read for review instead of acting on it', async () => {
      const mock = await seedMessage('Do you sell sunglasses?');
      mock.mockResolvedValueOnce(claudeResponse({ ...FULL_EXTRACTION, confidence: 0.1 }));

      await queue.extractPending();

      const row = examRequests.listAll()[0];
      expect(row.status).toBe('needsAttention');
      expect(row.last_error).toContain('Low confidence');
    });

    it('retries a transient Claude failure', async () => {
      const mock = await seedMessage();
      mock.mockResolvedValueOnce(jsonResponse(529, {}));

      await queue.extractPending();

      const row = examRequests.listAll()[0];
      expect(row.retry_count).toBe(1);
      expect(row.status).toBe('received'); // still queued
    });

    it('stops retrying a malformed response', async () => {
      const mock = await seedMessage();
      mock.mockResolvedValueOnce(jsonResponse(200, { content: [{ type: 'text', text: 'not json' }] }));

      await queue.extractPending();

      const row = examRequests.listAll()[0];
      expect(row.status).toBe('needsAttention');
      expect(row.retry_count).toBe(0);
    });

    it('does nothing without a Claude key', async () => {
      await seedMessage();
      delete process.env.CLAUDE_API_KEY;

      await queue.extractPending();

      expect(examRequests.listByStatus('received')).toHaveLength(1);
    });
  });

  describe('drafting', () => {
    async function seedExtracted(extraction: Record<string, unknown> = FULL_EXTRACTION) {
      const mock = installFetchMock();
      mock
        .mockResolvedValueOnce(gmailListResponse(['m1']))
        .mockResolvedValueOnce(gmailMessageResponse({ id: 'm1', body: 'Book me.' }));
      await queue.pollGmail();

      mock.mockResolvedValueOnce(claudeResponse(extraction));
      await queue.extractPending();

      return mock;
    }

    it('creates the patient, checks eligibility, and drafts an invoice and reminder', async () => {
      const mock = await seedExtracted();
      // Calendar lookup for the requested date.
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

      const dto = await request(ctx.app).get(`/api/practice/exam-requests/${row.id}`);
      expect(dto.body.patient.full_name).toBe('Ada Lovelace');
      expect(dto.body.eligibility.is_eligible).toBe(true);
      expect(dto.body.eligibility.mode).toBe('mock');
      expect(dto.body.reminder.status).toBe('pending');
      expect(dto.body.invoice.status).toBe('draft');
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
      // The extraction blob is encrypted, so the raw row must not reveal
      // the number even though the extraction contained it.
      expect(JSON.stringify(row)).not.toContain('1111111111');
      expect(row.extracted_json!.startsWith('v1:')).toBe(true);
      // It is still readable through the decrypting accessor.
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
      expect(after.phone).toBe('555-EXISTING'); // not overwritten
      expect(patients.readHealthCard(existing.id, 'test')).toBe('1111111111'); // gap filled
    });

    it('drafts without an appointment when no calendar event matches', async () => {
      const mock = await seedExtracted();
      mock.mockResolvedValueOnce(jsonResponse(200, { items: [] }));

      await queue.draftPending();

      const row = examRequests.listAll()[0];
      expect(row.status).toBe('drafted');
      expect(row.appointment_id).toBeNull();
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
      const mock = installFetchMock();
      mock
        .mockResolvedValueOnce(gmailListResponse(['m1']))
        .mockResolvedValueOnce(gmailMessageResponse({ id: 'm1', body: 'Book me.' }));
      await queue.pollGmail();

      mock.mockResolvedValueOnce(claudeResponse(FULL_EXTRACTION));
      await queue.extractPending();

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

    it('creates, approves and sends the invoice once approved', async () => {
      process.env.WAVE_ACCESS_TOKEN = 'wave-token';
      process.env.WAVE_BUSINESS_ID = 'biz-1';
      process.env.WAVE_INCOME_ACCOUNT_ID = 'income-1';

      const { mock, row } = await seedDrafted();

      mock
        // findCustomerByEmail — no existing customer
        .mockResolvedValueOnce(jsonResponse(200, { data: { business: { customers: { pageInfo: { currentPage: 1, totalPages: 1 }, edges: [] } } } }))
        // customerCreate
        .mockResolvedValueOnce(
          jsonResponse(200, {
            data: { customerCreate: { didSucceed: true, customer: { id: 'cust-1', name: 'Ada', email: 'ada@example.com' } } },
          }),
        )
        // invoiceCreate
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
        // invoiceApprove
        .mockResolvedValueOnce(
          jsonResponse(200, { data: { invoiceApprove: { didSucceed: true, invoice: { id: 'inv-1' } } } }),
        )
        // invoiceSend
        .mockResolvedValueOnce(jsonResponse(200, { data: { invoiceSend: { didSucceed: true } } }));

      const result = await queue.approveExamRequest(row.id);

      expect(result.invoice.created).toBe(true);
      expect(result.invoice.error).toBeNull();
      expect(examRequests.getExamRequest(row.id)!.status).toBe('completed');

      const dto = await request(ctx.app).get(`/api/practice/exam-requests/${row.id}`);
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
      const reminders = await import('../../server/practice/reminders.js');

      queue.rejectExamRequest(row.id);

      expect(examRequests.getExamRequest(row.id)!.status).toBe('rejected');
      expect(reminders.findForAppointment(row.appointment_id!)!.status).toBe('cancelled');
    });
  });

  describe('reminder dispatch', () => {
    /**
     * Drives a request to `drafted` for an appointment close enough that
     * its reminder is already due — reminders are scheduled
     * REMINDER_LEAD_HOURS (24 by default) before the appointment, so an
     * appointment less than a day out is due now.
     */
    async function seedDueReminder() {
      const soon = new Date(Date.now() + 60 * 60 * 1000); // an hour from now
      // Both parts must come from the *local* clock: the app reads a
      // requested date and time as clinic-local wall time. Taking the date
      // from toISOString() (UTC) would land on the wrong day whenever the
      // two disagree, which is most evenings west of Greenwich.
      const pad = (n: number) => String(n).padStart(2, '0');
      const day = `${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}`;
      const time = `${pad(soon.getHours())}:${pad(soon.getMinutes())}`;

      const mock = installFetchMock();
      mock
        .mockResolvedValueOnce(gmailListResponse(['m1']))
        .mockResolvedValueOnce(gmailMessageResponse({ id: 'm1', body: 'Book me.' }));
      await queue.pollGmail();

      mock.mockResolvedValueOnce(
        claudeResponse({ ...FULL_EXTRACTION, requested_date: day, requested_time: time }),
      );
      await queue.extractPending();

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

      // Approval without Wave configured still releases the reminder —
      // the two halves fail independently.
      await queue.approveExamRequest(row.id);

      mock.mockResolvedValueOnce(jsonResponse(200, { id: 'sent-1' }));
      expect(await queue.sendDueReminders()).toBe(1);

      const reminders = await import('../../server/practice/reminders.js');
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

      // Already sent, so it is no longer due.
      expect(await queue.sendDueReminders()).toBe(0);
    });

    it('retries a transient send failure and keeps the reminder pending', async () => {
      const { mock, row } = await seedDueReminder();
      await queue.approveExamRequest(row.id);

      mock.mockResolvedValueOnce(jsonResponse(503, {}));
      expect(await queue.sendDueReminders()).toBe(0);

      const reminders = await import('../../server/practice/reminders.js');
      const reminder = reminders.findForAppointment(row.appointment_id!)!;
      expect(reminder.status).toBe('pending');
      expect(reminder.retry_count).toBe(1);
      expect(reminder.last_error).toBeTruthy();
    });

    it('gives up on a reminder whose connection is broken', async () => {
      const { mock, row } = await seedDueReminder();
      await queue.approveExamRequest(row.id);

      // 401 is not retryable — reconnecting is the only fix.
      mock.mockResolvedValueOnce(jsonResponse(401, {}));
      expect(await queue.sendDueReminders()).toBe(0);

      const reminders = await import('../../server/practice/reminders.js');
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
      const mock = installFetchMock();
      mock
        .mockResolvedValueOnce(gmailListResponse(['m1']))
        .mockResolvedValueOnce(gmailMessageResponse({ id: 'm1', body: 'Book me.' }));
      await queue.pollGmail();

      mock.mockResolvedValueOnce(claudeResponse({ ...FULL_EXTRACTION, requested_date: '2026-09-01' }));
      await queue.extractPending();

      mock.mockResolvedValueOnce(
        jsonResponse(200, {
          items: [
            {
              id: 'evt-1',
              summary: 'Exam — Ada Lovelace',
              // Already in the past, so its reminder is due immediately.
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
      // Nothing was sent, so no new Gmail send request went out.
      expect(mock.mock.calls.length).toBe(callsBefore);
    });
  });
});
