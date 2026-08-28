import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestApp, type TestContext } from '../helpers/testApp.js';
import { installFetchMock, jsonResponse } from '../helpers/fetchMock.js';

/**
 * The exams API surface added alongside the queue: editable invoice
 * drafts, manually-entered appointments, patient linking, the audit log,
 * and the configuration endpoints behind the Settings screens.
 */

const PASSWORD = 'test-password';
const b64 = (s: string) => Buffer.from(s).toString('base64url');

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

describe('exams API', () => {
  let ctx: TestContext;
  let token: string;
  let queue: typeof import('../../server/exams/queue.js');
  let examRequests: typeof import('../../server/exams/exam-requests.js');
  let patients: typeof import('../../server/exams/patients.js');

  beforeEach(async () => {
    ctx = await setupTestApp({
      CLAUDE_API_KEY: 'test-claude-key',
      GMAIL_EXAM_REQUEST_QUERY: 'label:exam-requests',
    });

    await request(ctx.app).post('/api/auth/setup').send({ password: PASSWORD });
    const login = await request(ctx.app).post('/api/auth/login').send({ password: PASSWORD });
    const cookies = login.headers['set-cookie'] as unknown as string[];
    token = cookies.find((c) => c.startsWith('token='))!.split(';')[0].slice('token='.length);

    queue = await import('../../server/exams/queue.js');
    examRequests = await import('../../server/exams/exam-requests.js');
    patients = await import('../../server/exams/patients.js');

    const store = await import('../../server/platform/oauth-store.js');
    store.saveTokens('google', {
      accessToken: 'google-token',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    ctx.teardown();
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });

  /** Drives a request through to `drafted` with everything mocked. */
  async function seedDrafted() {
    const mock = installFetchMock();
    mock
      .mockResolvedValueOnce(jsonResponse(200, { messages: [{ id: 'm1', threadId: 't1' }] }))
      .mockResolvedValueOnce(
        jsonResponse(200, {
          id: 'm1',
          threadId: 't1',
          internalDate: String(Date.parse('2026-08-20T09:00:00Z')),
          snippet: 'Book me',
          payload: {
            headers: [{ name: 'From', value: 'ada@example.com' }],
            mimeType: 'text/plain',
            body: { data: b64('Please book an exam.') },
          },
        }),
      );
    await queue.pollGmail();

    mock.mockResolvedValueOnce(
      jsonResponse(200, { content: [{ type: 'text', text: JSON.stringify(FULL_EXTRACTION) }] }),
    );
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

  describe('invoice line items', () => {
    it('drafts a default line from the configured exam fee', async () => {
      process.env.EXAM_FEE_AMOUNT = '120';
      const { row } = await seedDrafted();

      const res = await request(ctx.app).get(`/api/exams/exam-requests/${row.id}`).set(auth());
      expect(res.body.invoice.line_items).toHaveLength(1);
      expect(res.body.invoice.line_items[0].unitPrice).toBe(120);
      expect(res.body.invoice.editable).toBe(true);
    });

    it('replaces the lines and recomputes the total', async () => {
      const { row } = await seedDrafted();

      const res = await request(ctx.app)
        .put(`/api/exams/exam-requests/${row.id}/invoice`)
        .set(auth())
        .send({
          line_items: [
            { description: 'Eye exam', quantity: 1, unitPrice: 120 },
            { description: 'Contact lens fitting', quantity: 2, unitPrice: 40.5 },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.request.invoice.amount).toBe(201);
      expect(res.body.request.invoice.line_items).toHaveLength(2);
    });

    it('rejects an invoice with no lines', async () => {
      const { row } = await seedDrafted();

      const res = await request(ctx.app)
        .put(`/api/exams/exam-requests/${row.id}/invoice`)
        .set(auth())
        .send({ line_items: [] });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/at least one line/i);
    });

    it.each([
      [{ description: '', quantity: 1, unitPrice: 10 }, /description/i],
      [{ description: 'x', quantity: 0, unitPrice: 10 }, /quantity/i],
      [{ description: 'x', quantity: 1, unitPrice: -5 }, /unit price/i],
    ])('rejects a malformed line (%#)', async (line, expected) => {
      const { row } = await seedDrafted();

      const res = await request(ctx.app)
        .put(`/api/exams/exam-requests/${row.id}/invoice`)
        .set(auth())
        .send({ line_items: [line] });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(expected);
    });

    it('sends the edited lines to Wave on approval', async () => {
      process.env.WAVE_ACCESS_TOKEN = 'wave-token';
      process.env.WAVE_BUSINESS_ID = 'biz-1';
      process.env.WAVE_INCOME_ACCOUNT_ID = 'income-1';

      const { mock, row } = await seedDrafted();

      await request(ctx.app)
        .put(`/api/exams/exam-requests/${row.id}/invoice`)
        .set(auth())
        .send({
          line_items: [
            { description: 'Eye exam', quantity: 1, unitPrice: 120 },
            { description: 'Form fee', quantity: 1, unitPrice: 30 },
          ],
        });

      mock
        .mockResolvedValueOnce(
          jsonResponse(200, {
            data: { business: { customers: { pageInfo: { currentPage: 1, totalPages: 1 }, edges: [] } } },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse(200, {
            data: { customerCreate: { didSucceed: true, customer: { id: 'c1', name: 'Ada', email: 'ada@example.com' } } },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse(200, {
            data: {
              invoiceCreate: {
                didSucceed: true,
                invoice: { id: 'inv-1', invoiceNumber: '1001', total: { value: 150 } },
              },
            },
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse(200, { data: { invoiceApprove: { didSucceed: true, invoice: { id: 'inv-1' } } } }),
        )
        .mockResolvedValueOnce(jsonResponse(200, { data: { invoiceSend: { didSucceed: true } } }));

      const res = await request(ctx.app)
        .post(`/api/exams/exam-requests/${row.id}/approve`)
        .set(auth());
      expect(res.status).toBe(200);

      const invoiceCall = mock.mock.calls.find((c) =>
        String((c[1] as RequestInit).body).includes('invoiceCreate'),
      )!;
      const sent = JSON.parse((invoiceCall[1] as RequestInit).body as string);
      expect(sent.variables.input.items).toHaveLength(2);
      expect(sent.variables.input.items[1].description).toBe('Form fee');
      expect(sent.variables.input.items[0].accountId).toBe('income-1');
    });

    it('refuses to edit an invoice that already exists in Wave', async () => {
      const { row } = await seedDrafted();
      const invoice = queue.getInvoiceForRequest(row.id)!;
      queue.updateInvoiceRow(invoice.id, { status: 'sent', wave_invoice_id: 'inv-1' });

      const res = await request(ctx.app)
        .put(`/api/exams/exam-requests/${row.id}/invoice`)
        .set(auth())
        .send({ line_items: [{ description: 'x', quantity: 1, unitPrice: 1 }] });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/already been created in Wave/i);
    });
  });

  describe('manual appointments', () => {
    it('creates one and marks it manual, not a calendar event', async () => {
      const res = await request(ctx.app)
        .post('/api/exams/appointments')
        .set(auth())
        .send({ startsAt: '2026-09-01T10:00:00.000Z', title: 'Walk-in' });

      expect(res.status).toBe(201);
      expect(res.body.source).toBe('manual');
      expect(res.body.google_event_id).toBeNull();
    });

    it('can be linked to a patient at creation', async () => {
      const patient = patients.createPatient({ full_name: 'Ada' });

      const res = await request(ctx.app)
        .post('/api/exams/appointments')
        .set(auth())
        .send({ startsAt: '2026-09-01T10:00:00.000Z', patientId: patient.id });

      expect(res.status).toBe(201);
      expect(res.body.patient_id).toBe(patient.id);
    });

    it.each([
      [{}, /valid start date/i],
      [{ startsAt: 'not-a-date' }, /valid start date/i],
      [{ startsAt: '2026-09-01T10:00:00.000Z', endsAt: '2026-09-01T09:00:00.000Z' }, /cannot be before/i],
    ])('rejects invalid input (%#)', async (body, expected) => {
      const res = await request(ctx.app).post('/api/exams/appointments').set(auth()).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(expected);
    });

    it('rejects an unknown patient', async () => {
      const res = await request(ctx.app)
        .post('/api/exams/appointments')
        .set(auth())
        .send({ startsAt: '2026-09-01T10:00:00.000Z', patientId: 'nope' });

      expect(res.status).toBe(400);
    });

    it('appears on the schedule and can be deleted', async () => {
      const created = await request(ctx.app)
        .post('/api/exams/appointments')
        .set(auth())
        .send({ startsAt: new Date(Date.now() + 86_400_000).toISOString(), title: 'Walk-in' });

      const list = await request(ctx.app).get('/api/exams/appointments').set(auth());
      expect(list.body.map((a: any) => a.id)).toContain(created.body.id);

      expect(
        (await request(ctx.app).delete(`/api/exams/appointments/${created.body.id}`).set(auth())).status,
      ).toBe(200);
      expect(
        (await request(ctx.app).delete(`/api/exams/appointments/${created.body.id}`).set(auth())).status,
      ).toBe(404);
    });
  });

  describe('linking a patient', () => {
    it('links, and the appointment then reports the patient', async () => {
      const patient = patients.createPatient({ full_name: 'Ada' });
      const created = await request(ctx.app)
        .post('/api/exams/appointments')
        .set(auth())
        .send({ startsAt: new Date(Date.now() + 86_400_000).toISOString() });

      const res = await request(ctx.app)
        .post(`/api/exams/appointments/${created.body.id}/link-patient`)
        .set(auth())
        .send({ patientId: patient.id });
      expect(res.status).toBe(200);

      const list = await request(ctx.app).get('/api/exams/appointments').set(auth());
      const found = list.body.find((a: any) => a.id === created.body.id);
      expect(found.patient.full_name).toBe('Ada');
    });

    it('rejects a patient that does not exist', async () => {
      const created = await request(ctx.app)
        .post('/api/exams/appointments')
        .set(auth())
        .send({ startsAt: new Date(Date.now() + 86_400_000).toISOString() });

      const res = await request(ctx.app)
        .post(`/api/exams/appointments/${created.body.id}/link-patient`)
        .set(auth())
        .send({ patientId: 'nope' });
      expect(res.status).toBe(400);
    });
  });

  describe('audit log', () => {
    it('returns entries newest first and never leaks a health card', async () => {
      const patient = patients.createPatient({ full_name: 'Ada', health_card_number: '1111111111' });
      await request(ctx.app).get(`/api/exams/patients/${patient.id}`).set(auth());

      const res = await request(ctx.app).get('/api/exams/audit').set(auth());
      expect(res.status).toBe(200);

      const actions = res.body.map((e: any) => e.action);
      expect(actions).toContain('patient.read');
      expect(actions).toContain('login.success');
      expect(JSON.stringify(res.body)).not.toContain('1111111111');

      const times = res.body.map((e: any) => e.id);
      expect(times).toEqual([...times].sort((a, b) => b - a));
    });

    it('requires a session', async () => {
      expect((await request(ctx.app).get('/api/exams/audit')).status).toBe(401);
    });
  });

  describe('configuration', () => {
    it('reports invoicing as not ready until a target is chosen', async () => {
      const before = await request(ctx.app).get('/api/settings/exams').set(auth());
      expect(before.body.invoicingReady).toBe(false);

      await request(ctx.app)
        .post('/api/settings/exams')
        .set(auth())
        .send({ waveIncomeAccountId: 'income-1' });

      const after = await request(ctx.app).get('/api/settings/exams').set(auth());
      expect(after.body.invoicingReady).toBe(true);
      expect(after.body.waveIncomeAccountId).toBe('income-1');
    });

    it('refuses both a product and an income account', async () => {
      const res = await request(ctx.app)
        .post('/api/settings/exams')
        .set(auth())
        .send({ waveIncomeAccountId: 'income-1', waveServiceProductId: 'prod-1' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/not both/i);
    });

    it.each([
      [{ minConfidence: 1.5 }, /between 0 and 1/i],
      [{ reminderLeadHours: 0 }, /more than zero/i],
      [{ examFeeAmount: -1 }, /cannot be negative/i],
    ])('validates settings (%#)', async (body, expected) => {
      const res = await request(ctx.app).post('/api/settings/exams').set(auth()).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(expected);
    });

    it('saves the Gmail query the queue reads', async () => {
      await request(ctx.app)
        .post('/api/settings/exams')
        .set(auth())
        .send({ gmailQuery: 'label:bookings' });

      expect(queue.gmailQuery()).toBe('label:bookings');
    });
  });

  describe('OHIP configuration', () => {
    it('defaults to mock and never returns the secrets', async () => {
      const res = await request(ctx.app).get('/api/settings/ohip').set(auth());

      expect(res.body.mode).toBe('mock');
      expect(res.body.hasPassword).toBe(false);
      expect(res.body).not.toHaveProperty('password');
      expect(res.body).not.toHaveProperty('conformanceKey');
    });

    it('saves credentials and reports them as set without echoing them', async () => {
      await request(ctx.app).post('/api/settings/ohip').set(auth()).send({
        mode: 'conformance',
        privateKeyPath: '/keys/k.pem',
        certificatePath: '/keys/c.pem',
        username: 'dr-smith',
        password: 'secret',
        mohId: '123456',
        conformanceKey: 'key-abc',
      });

      const res = await request(ctx.app).get('/api/settings/ohip').set(auth());
      expect(res.body.mode).toBe('conformance');
      expect(res.body.hasPassword).toBe(true);
      expect(res.body.hasConformanceKey).toBe(true);
      expect(JSON.stringify(res.body)).not.toContain('secret');
      expect(JSON.stringify(res.body)).not.toContain('key-abc');
    });

    it('leaves stored secrets alone when the form omits them', async () => {
      await request(ctx.app)
        .post('/api/settings/ohip')
        .set(auth())
        .send({ mode: 'conformance', password: 'secret', conformanceKey: 'key-abc' });

      // Saving again without retyping must not wipe them.
      await request(ctx.app).post('/api/settings/ohip').set(auth()).send({ mohId: '999' });

      const res = await request(ctx.app).get('/api/settings/ohip').set(auth());
      expect(res.body.hasPassword).toBe(true);
      expect(res.body.hasConformanceKey).toBe(true);
      expect(res.body.mohId).toBe('999');
    });

    it('rejects an unknown mode', async () => {
      const res = await request(ctx.app).post('/api/settings/ohip').set(auth()).send({ mode: 'yolo' });
      expect(res.status).toBe(400);
    });

    it('refuses to test while in mock mode', async () => {
      const res = await request(ctx.app).post('/api/settings/ohip/test').set(auth()).send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/mock mode/i);
    });

    it('reports missing credentials when testing a real mode', async () => {
      await request(ctx.app).post('/api/settings/ohip').set(auth()).send({ mode: 'conformance' });

      const res = await request(ctx.app).post('/api/settings/ohip/test').set(auth()).send({});
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toMatch(/not set/i);
    });
  });

  describe('email source is PHI (P0-1)', () => {
    it('keeps the raw email out of the exam-request DTO', async () => {
      const { row } = await seedDrafted();

      const res = await request(ctx.app).get(`/api/exams/exam-requests/${row.id}`).set(auth());
      expect(res.body.has_source).toBe(true);
      expect(res.body).not.toHaveProperty('body_snippet');
      expect(JSON.stringify(res.body)).not.toContain('Please book an exam');
    });

    it('stores the retained email slice encrypted, not as plaintext', async () => {
      await seedDrafted();
      const stored = examRequests.listAll()[0];
      expect(stored.body_snippet).toMatch(/^v1:/);
      expect(stored.body_snippet).not.toContain('Please book an exam');
    });

    it('serves the body through the /source route and audits the access', async () => {
      const { row } = await seedDrafted();

      const res = await request(ctx.app)
        .get(`/api/exams/exam-requests/${row.id}/source`)
        .set(auth());
      expect(res.status).toBe(200);
      expect(res.body.body).toBe('Please book an exam.');

      const audit = await request(ctx.app).get('/api/exams/audit').set(auth());
      const entry = audit.body.find((e: any) => e.action === 'exam_request.source_read');
      expect(entry).toBeTruthy();
      expect(entry.entity_id).toBe(row.id);
    });

    it('404s the /source route for an unknown request', async () => {
      const res = await request(ctx.app)
        .get('/api/exams/exam-requests/nope/source')
        .set(auth());
      expect(res.status).toBe(404);
    });
  });
});
