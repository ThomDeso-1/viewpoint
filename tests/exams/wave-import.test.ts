import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { setupTestApp, type TestContext } from '../helpers/testApp.js';
import { installFetchMock, jsonResponse } from '../helpers/fetchMock.js';

/**
 * Spec (migration 011, server/exams/wave-import.ts): the one-time Wave
 * customer import into the client directory.
 *
 *  - verify reads ONE customer with the full field set; the import can't
 *    run until that has passed, and a failure names Wave's error.
 *  - preview reads everything and writes nothing.
 *  - apply writes the previewed plan: email match → link, name-only match
 *    → flagged for the operator, otherwise → new client. Never overwrites
 *    a field already on file.
 */

const PASSWORD = 'test-password';

interface Cust {
  id: string;
  name: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
  internalNotes?: string | null;
  isArchived?: boolean;
  address?: Record<string, unknown> | null;
}

function customerPage(customers: Cust[], page = 1, totalPages = 1) {
  return jsonResponse(200, {
    data: {
      business: {
        customers: {
          pageInfo: { currentPage: page, totalPages, totalCount: customers.length },
          edges: customers.map((c) => ({
            node: {
              firstName: null,
              lastName: null,
              email: null,
              phone: null,
              mobile: null,
              internalNotes: null,
              isArchived: false,
              address: null,
              ...c,
            },
          })),
        },
      },
    },
  });
}

describe('Wave client import', () => {
  let ctx: TestContext;
  let token: string;
  let patients: typeof import('../../server/exams/patients.js');
  let fetchMock: ReturnType<typeof installFetchMock>;

  beforeEach(async () => {
    ctx = await setupTestApp({ WAVE_ACCESS_TOKEN: 'wave-token', WAVE_BUSINESS_ID: 'biz-1' });

    await request(ctx.app).post('/api/auth/setup').send({ password: PASSWORD });
    const login = await request(ctx.app).post('/api/auth/login').send({ password: PASSWORD });
    const cookies = login.headers['set-cookie'] as unknown as string[];
    token = cookies.find((c) => c.startsWith('token='))!.split(';')[0].slice('token='.length);

    patients = await import('../../server/exams/patients.js');
    fetchMock = installFetchMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    ctx.teardown();
  });

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const post = (path: string, body?: object) =>
    request(ctx.app).post(`/api/exams/wave-import/${path}`).set(auth()).send(body ?? {});

  async function verify() {
    fetchMock.mockResolvedValueOnce(customerPage([{ id: 'c-probe', name: 'Probe' }]));
    const res = await post('verify');
    expect(res.body.ok).toBe(true);
  }

  async function preview(customers: Cust[]) {
    fetchMock.mockResolvedValueOnce(customerPage(customers));
    const res = await post('preview');
    expect(res.status).toBe(200);
    return res.body;
  }

  describe('verify', () => {
    it('reads a single customer with the full field set and remembers the pass', async () => {
      await verify();

      const [, init] = fetchMock.mock.calls[0];
      const body = JSON.parse(init.body);
      expect(body.variables).toMatchObject({ businessId: 'biz-1', page: 1, pageSize: 1 });
      for (const field of ['email', 'phone', 'mobile', 'isArchived', 'internalNotes', 'addressLine1']) {
        expect(body.query).toContain(field);
      }

      const status = await request(ctx.app).get('/api/exams/wave-import/status').set(auth());
      expect(status.body.verifiedAt).toBeTruthy();
      expect(status.body.waveConfigured).toBe(true);
    });

    it("reports Wave's error when a field is not recognised, and stays unverified", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(200, { errors: [{ message: "Cannot query field 'mobile' on type 'Customer'." }] }),
      );

      const res = await post('verify');

      expect(res.body.ok).toBe(false);
      expect(res.body.error).toContain("Cannot query field 'mobile'");
      const status = await request(ctx.app).get('/api/exams/wave-import/status').set(auth());
      expect(status.body.verifiedAt).toBeNull();
    });

    it('refuses when Wave is not configured', async () => {
      delete process.env.WAVE_BUSINESS_ID;
      const res = await post('verify');
      expect(res.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('preview', () => {
    it('cannot run before verify has passed', async () => {
      const res = await post('preview');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('not_verified');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('classifies every customer and writes nothing', async () => {
      patients.createPatient({ full_name: 'Ada Lovelace', email: 'ada@example.com' });
      patients.createPatient({ full_name: 'Grace Hopper', email: 'grace@navy.example' });
      await verify();

      const p = await preview([
        { id: 'w-ada', name: 'Ada Lovelace', email: 'ADA@example.com' }, // email → link
        { id: 'w-grace', name: 'Grace Hopper', email: 'grace@other.example' }, // name only
        { id: 'w-alan', name: 'Alan Turing', firstName: 'Alan', lastName: 'Turing' }, // new
        { id: 'w-lab', name: 'Acme Lens Labs Inc.' }, // new business
        { id: 'w-gone', name: 'Old Account', isArchived: true }, // skipped
      ]);

      expect(p.fetched).toBe(5);
      expect(p.archived).toBe(1);
      expect(p.counts).toEqual({ new: 2, link: 1, update: 0, unchanged: 0, nameMatch: 1 });
      expect(p.newByType).toEqual({ patient: 0, customer: 1, business: 1 });
      expect(p.links[0].client.full_name).toBe('Ada Lovelace');
      expect(p.nameMatches[0]).toMatchObject({ waveName: 'Grace Hopper', email: 'grace@other.example' });

      // Nothing written yet.
      expect(patients.listPatients()).toHaveLength(2);
      expect(patients.listPatients().every((row) => row.wave_customer_id === null)).toBe(true);
    });

    it('reads every page', async () => {
      await verify();
      fetchMock
        .mockResolvedValueOnce(customerPage([{ id: 'w-1', name: 'One Person' }], 1, 2))
        .mockResolvedValueOnce(customerPage([{ id: 'w-2', name: 'Two Person' }], 2, 2));

      const res = await post('preview');

      expect(res.body.fetched).toBe(2);
      expect(res.body.counts.new).toBe(2);
    });
  });

  describe('apply', () => {
    it('creates, links and flags, filling gaps without overwriting', async () => {
      const ada = patients.createPatient({
        full_name: 'Ada Lovelace',
        email: 'ada@example.com',
        phone: '555-KEEP',
      });
      const grace = patients.createPatient({ full_name: 'Grace Hopper' });
      await verify();

      const p = await preview([
        {
          id: 'w-ada',
          name: 'Ada Lovelace',
          email: 'ada@example.com',
          phone: '555-WAVE',
          address: { addressLine1: '1 Engine St', city: 'London', province: { name: 'Ontario' } },
        },
        { id: 'w-grace', name: 'Grace Hopper', email: 'g@example.com' },
        { id: 'w-alan', name: 'Alan Turing', mobile: '555-0199', internalNotes: 'Bifocals' },
      ]);

      const res = await post('apply', { previewId: p.previewId });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ created: 2, linked: 1, updated: 0, flagged: 1, skipped: 0 });

      const adaAfter = patients.getPatient(ada.id)!;
      expect(adaAfter.wave_customer_id).toBe('w-ada');
      expect(adaAfter.phone).toBe('555-KEEP'); // not overwritten
      expect(adaAfter.address).toBe('1 Engine St, London, Ontario'); // gap filled
      expect(adaAfter.client_type).toBe('patient'); // linking keeps the kind

      const graceDup = patients.findPatientByWaveCustomerId('w-grace')!;
      expect(graceDup.id).not.toBe(grace.id);
      expect(graceDup.possible_duplicate_of).toBe(grace.id);

      const alan = patients.findPatientByWaveCustomerId('w-alan')!;
      expect(alan).toMatchObject({
        full_name: 'Alan Turing',
        client_type: 'customer',
        phone: '555-0199', // mobile when there's no phone
        notes: 'Bifocals',
        date_of_birth: null,
        health_card_enc: null,
        possible_duplicate_of: null,
      });
    });

    it("honours the operator's choice for a name-only match", async () => {
      const grace = patients.createPatient({ full_name: 'Grace Hopper' });
      const mary = patients.createPatient({ full_name: 'Mary Jackson' });
      await verify();

      const p = await preview([
        { id: 'w-grace', name: 'Grace Hopper', email: 'g@example.com' },
        { id: 'w-mary', name: 'Mary Jackson' },
      ]);

      const res = await post('apply', {
        previewId: p.previewId,
        decisions: { 'w-grace': 'link', 'w-mary': 'skip' },
      });

      expect(res.body).toMatchObject({ created: 0, linked: 1, skipped: 1 });
      expect(patients.getPatient(grace.id)!.wave_customer_id).toBe('w-grace');
      expect(patients.getPatient(grace.id)!.email).toBe('g@example.com');
      expect(patients.getPatient(mary.id)!.wave_customer_id).toBeNull();
      expect(patients.listPatients()).toHaveLength(2);
    });

    it('is safe to run again — a second import only fills gaps', async () => {
      await verify();
      const first = await preview([{ id: 'w-alan', name: 'Alan Turing' }]);
      await post('apply', { previewId: first.previewId });

      const second = await preview([{ id: 'w-alan', name: 'Alan Turing', email: 'alan@example.com' }]);
      expect(second.counts).toMatchObject({ new: 0, update: 1 });
      const res = await post('apply', { previewId: second.previewId });

      expect(res.body).toMatchObject({ created: 0, updated: 1 });
      expect(patients.listPatients()).toHaveLength(1);
      expect(patients.findPatientByWaveCustomerId('w-alan')!.email).toBe('alan@example.com');
    });

    it('rejects a stale or unknown preview', async () => {
      await verify();
      const p = await preview([{ id: 'w-alan', name: 'Alan Turing' }]);
      await post('apply', { previewId: p.previewId });

      const again = await post('apply', { previewId: p.previewId });
      expect(again.status).toBe(409);
      expect(patients.listPatients()).toHaveLength(1);
    });

    it('writes one audit row with counts and no names', async () => {
      await verify();
      const p = await preview([{ id: 'w-alan', name: 'Alan Turing', email: 'alan@example.com' }]);
      await post('apply', { previewId: p.previewId });

      const audit = await request(ctx.app).get('/api/exams/audit').set(auth());
      const entries = audit.body as { action: string; detail: string | null }[];
      const imports = entries.filter((e) => e.action === 'client.import');
      expect(imports).toHaveLength(1);
      expect(imports[0].detail).toContain('1 created');
      expect(imports[0].detail).not.toContain('Alan');
      expect(imports[0].detail).not.toContain('alan@example.com');
      // Not one patient.create per imported row.
      expect(entries.filter((e) => e.action === 'patient.create')).toHaveLength(0);
    });
  });

  describe('client records', () => {
    it('rejects an unknown client type', async () => {
      const row = patients.createPatient({ full_name: 'Ada Lovelace' });
      const res = await request(ctx.app)
        .put(`/api/exams/patients/${row.id}`)
        .set(auth())
        .send({ client_type: 'supplier' });
      expect(res.status).toBe(400);
    });

    it('reclassifies a client and clears a duplicate flag', async () => {
      const grace = patients.createPatient({ full_name: 'Grace Hopper' });
      await verify();
      const p = await preview([{ id: 'w-grace', name: 'Grace Hopper' }]);
      await post('apply', { previewId: p.previewId });
      const dup = patients.findPatientByWaveCustomerId('w-grace')!;

      const detail = await request(ctx.app).get(`/api/exams/patients/${dup.id}`).set(auth());
      expect(detail.body.possible_duplicate).toEqual({ id: grace.id, full_name: 'Grace Hopper' });

      const res = await request(ctx.app)
        .put(`/api/exams/patients/${dup.id}`)
        .set(auth())
        .send({ client_type: 'business', possible_duplicate_of: null });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ client_type: 'business', possible_duplicate_of: null });
    });

    it('ignores an attempt to set a duplicate flag by hand', async () => {
      const a = patients.createPatient({ full_name: 'A' });
      const b = patients.createPatient({ full_name: 'B' });
      await request(ctx.app)
        .put(`/api/exams/patients/${a.id}`)
        .set(auth())
        .send({ possible_duplicate_of: b.id });
      expect(patients.getPatient(a.id)!.possible_duplicate_of).toBeNull();
    });
  });
});
