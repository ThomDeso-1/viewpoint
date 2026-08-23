import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import request from 'supertest';
import { setupTestApp, fakeImageBytes, type TestContext } from './helpers/testApp.js';

/**
 * Spec (CONVERSION-PLAN.md "Receipt Pipeline" + GETTING-STARTED.md):
 *  captured → extracted → reviewed → uploaded
 * A receipt is created by uploading photo(s); it lives in a monthly
 * `Receipts/YYYY-MM/` folder; the list groups receipts by month and
 * supports search/status filtering; approving (PUT status=reviewed)
 * moves its files if the receipt date's month changed; deleting a
 * receipt removes its files.
 */
describe('receipts', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestApp();
  });

  afterAll(() => ctx.teardown());

  describe('capturing a receipt', () => {
    it('rejects a request with no images', async () => {
      const res = await request(ctx.app).post('/api/receipts');
      expect(res.status).toBe(400);
    });

    it('creates a receipt from an uploaded photo, defaulting to status=captured', async () => {
      const res = await request(ctx.app)
        .post('/api/receipts')
        .attach('images', fakeImageBytes('a'), { filename: 'a.jpg', contentType: 'image/jpeg' });

      expect(res.status).toBe(201);
      expect(res.body).toHaveLength(1);
      const receipt = res.body[0];
      expect(receipt.status).toBe('captured');
      expect(receipt.id).toBeTruthy();
      expect(receipt.image_hash).toBeTruthy();
      expect(receipt.month_folder).toMatch(/^\d{4}-\d{2}$/);
    });

    it('rejects non-image files', async () => {
      const res = await request(ctx.app)
        .post('/api/receipts')
        .attach('images', Buffer.from('not an image'), { filename: 'a.txt', contentType: 'text/plain' });
      expect(res.status).toBeGreaterThanOrEqual(400);
    });

    it('actually writes the image bytes to disk under Receipts/<month>/', async () => {
      const res = await request(ctx.app)
        .post('/api/receipts')
        .attach('images', fakeImageBytes('disk-check'), { filename: 'a.jpg', contentType: 'image/jpeg' });
      const receipt = res.body[0];
      const abs = `${ctx.dataDir}/Receipts/${receipt.primary_image}`;
      expect(fs.existsSync(abs)).toBe(true);
      expect(fs.readFileSync(abs).includes('disk-check')).toBe(true);
    });

    it('supports multiple images in one upload (front + back)', async () => {
      const res = await request(ctx.app)
        .post('/api/receipts')
        .attach('images', fakeImageBytes('multi1'), { filename: 'a.jpg', contentType: 'image/jpeg' })
        .attach('images', fakeImageBytes('multi2'), { filename: 'b.jpg', contentType: 'image/jpeg' });

      expect(res.status).toBe(201);
      // Per the API contract each uploaded file becomes its own receipt
      // (there is no separate "attach as page 2" endpoint) — assert the
      // documented shape rather than assuming: two receipts come back.
      expect(res.body).toHaveLength(2);
    });
  });

  describe('listing receipts', () => {
    it('groups receipts by month, newest month first', async () => {
      const res = await request(ctx.app).get('/api/receipts');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const months = res.body.map((g: any) => g.month);
      const sorted = [...months].sort().reverse();
      expect(months).toEqual(sorted);
      for (const group of res.body) {
        expect(Array.isArray(group.receipts)).toBe(true);
        for (const r of group.receipts) {
          expect(r.month_folder).toBe(group.month);
        }
      }
    });

    it('filters by status', async () => {
      const res = await request(ctx.app).get('/api/receipts').query({ status: 'captured' });
      expect(res.status).toBe(200);
      for (const group of res.body) {
        for (const r of group.receipts) {
          expect(r.status).toBe('captured');
        }
      }
    });

    it('returns nothing for a status with no matches', async () => {
      const res = await request(ctx.app).get('/api/receipts').query({ status: 'uploaded' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('a single receipt', () => {
    let receiptId: string;

    beforeAll(async () => {
      const res = await request(ctx.app)
        .post('/api/receipts')
        .attach('images', fakeImageBytes('single'), { filename: 'a.jpg', contentType: 'image/jpeg' });
      receiptId = res.body[0].id;
    });

    it('is fetchable by id', async () => {
      const res = await request(ctx.app).get(`/api/receipts/${receiptId}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(receiptId);
    });

    it('404s for an unknown id', async () => {
      const res = await request(ctx.app).get('/api/receipts/does-not-exist');
      expect(res.status).toBe(404);
    });

    it('is searchable by vendor once reviewed with a vendor name', async () => {
      await request(ctx.app).put(`/api/receipts/${receiptId}`).send({ vendor: 'Home Depot' });
      const res = await request(ctx.app).get('/api/receipts').query({ search: 'home depot' });
      const found = res.body.flatMap((g: any) => g.receipts).some((r: any) => r.id === receiptId);
      expect(found).toBe(true);
    });

    it('search is case-insensitive and matches partial vendor names', async () => {
      const res = await request(ctx.app).get('/api/receipts').query({ search: 'DEPOT' });
      const found = res.body.flatMap((g: any) => g.receipts).some((r: any) => r.id === receiptId);
      expect(found).toBe(true);
    });

    it('search does not match unrelated text', async () => {
      const res = await request(ctx.app).get('/api/receipts').query({ search: 'zzz-nonexistent-vendor' });
      const found = res.body.flatMap((g: any) => g.receipts).some((r: any) => r.id === receiptId);
      expect(found).toBe(false);
    });
  });

  describe('reviewing / editing a receipt', () => {
    let receiptId: string;

    beforeAll(async () => {
      const res = await request(ctx.app)
        .post('/api/receipts')
        .attach('images', fakeImageBytes('review'), { filename: 'a.jpg', contentType: 'image/jpeg' });
      receiptId = res.body[0].id;
    });

    it('lets the user correct extracted fields', async () => {
      const res = await request(ctx.app).put(`/api/receipts/${receiptId}`).send({
        vendor: 'Staples',
        summary: 'Office supplies',
        total_amount: 42.5,
        tax_amount: 5.5,
        currency: 'CAD',
      });
      expect(res.status).toBe(200);
      expect(res.body.vendor).toBe('Staples');
      expect(res.body.total_amount).toBe(42.5);
      expect(res.body.tax_amount).toBe(5.5);
    });

    it('404s when updating an unknown receipt', async () => {
      const res = await request(ctx.app).put('/api/receipts/nope').send({ vendor: 'X' });
      expect(res.status).toBe(404);
    });

    it('rejects a malformed receipt_date instead of re-filing into a NaN-NaN folder', async () => {
      const before = await request(ctx.app).get(`/api/receipts/${receiptId}`);

      const res = await request(ctx.app)
        .put(`/api/receipts/${receiptId}`)
        .send({ receipt_date: 'not-a-date' });

      expect(res.status).toBe(400);
      const after = await request(ctx.app).get(`/api/receipts/${receiptId}`);
      expect(after.body.month_folder).toBe(before.body.month_folder);
    });

    it('approving (status=reviewed) is reflected on the receipt', async () => {
      const res = await request(ctx.app).put(`/api/receipts/${receiptId}`).send({ status: 'reviewed' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('reviewed');
    });

    it('moving the receipt date into a different month re-files its image', async () => {
      const before = await request(ctx.app).get(`/api/receipts/${receiptId}`);
      const oldImagePath = `${ctx.dataDir}/Receipts/${before.body.primary_image}`;
      expect(fs.existsSync(oldImagePath)).toBe(true);

      // Pick a date far enough in the past to land in a different month
      // than "now" regardless of when this test runs.
      const newDate = '2019-03-15T00:00:00.000Z';
      const res = await request(ctx.app)
        .put(`/api/receipts/${receiptId}`)
        .send({ receipt_date: newDate });

      expect(res.status).toBe(200);
      expect(res.body.month_folder).toBe('2019-03');
      expect(fs.existsSync(oldImagePath)).toBe(false);
      const newImagePath = `${ctx.dataDir}/Receipts/${res.body.primary_image}`;
      expect(fs.existsSync(newImagePath)).toBe(true);
    });
  });

  describe('deleting a receipt', () => {
    it('removes both the DB row and the image file', async () => {
      const created = await request(ctx.app)
        .post('/api/receipts')
        .attach('images', fakeImageBytes('delete-me'), { filename: 'a.jpg', contentType: 'image/jpeg' });
      const receipt = created.body[0];
      const imagePath = `${ctx.dataDir}/Receipts/${receipt.primary_image}`;
      expect(fs.existsSync(imagePath)).toBe(true);

      const del = await request(ctx.app).delete(`/api/receipts/${receipt.id}`);
      expect(del.status).toBe(200);
      expect(del.body).toEqual({ deleted: true });

      expect(fs.existsSync(imagePath)).toBe(false);
      const get = await request(ctx.app).get(`/api/receipts/${receipt.id}`);
      expect(get.status).toBe(404);
    });

    it('404s when deleting an unknown receipt', async () => {
      const res = await request(ctx.app).delete('/api/receipts/does-not-exist');
      expect(res.status).toBe(404);
    });

    it('cleans up the month folder once its last receipt is deleted', async () => {
      // A far-past, unique month so nothing else in this test file shares it.
      const date = '2017-11-15T00:00:00.000Z';
      const created = await request(ctx.app)
        .post('/api/receipts')
        .attach('images', fakeImageBytes('folder-cleanup'), { filename: 'a.jpg', contentType: 'image/jpeg' });
      const receipt = created.body[0];
      await request(ctx.app).put(`/api/receipts/${receipt.id}`).send({ receipt_date: date });

      const moved = await request(ctx.app).get(`/api/receipts/${receipt.id}`);
      const folder = `${ctx.dataDir}/Receipts/2017-11`;
      expect(fs.existsSync(folder)).toBe(true);

      await request(ctx.app).delete(`/api/receipts/${moved.body.id}`);
      expect(fs.existsSync(folder)).toBe(false);
    });
  });

  describe('duplicate detection', () => {
    it('flags a second upload of the exact same image bytes', async () => {
      const first = await request(ctx.app)
        .post('/api/receipts')
        .attach('images', fakeImageBytes('dup-content'), { filename: 'a.jpg', contentType: 'image/jpeg' });
      const second = await request(ctx.app)
        .post('/api/receipts')
        .attach('images', fakeImageBytes('dup-content'), { filename: 'b.jpg', contentType: 'image/jpeg' });

      const res = await request(ctx.app).get(`/api/receipts/${second.body[0].id}/duplicates`);
      expect(res.status).toBe(200);
      expect(res.body.warnings.length).toBeGreaterThan(0);
      void first;
    });

    it('does not flag two different images as duplicates', async () => {
      const created = await request(ctx.app)
        .post('/api/receipts')
        .attach('images', fakeImageBytes('unique-xyz'), { filename: 'a.jpg', contentType: 'image/jpeg' });
      const res = await request(ctx.app).get(`/api/receipts/${created.body[0].id}/duplicates`);
      expect(res.body.warnings).toEqual([]);
    });

    it('flags a receipt with the same vendor, total, and date as an existing one', async () => {
      const a = await request(ctx.app)
        .post('/api/receipts')
        .attach('images', fakeImageBytes('same-vendor-1'), { filename: 'a.jpg', contentType: 'image/jpeg' });
      await request(ctx.app).put(`/api/receipts/${a.body[0].id}`).send({
        vendor: 'Costco',
        total_amount: 88.88,
        receipt_date: '2024-06-01T00:00:00.000Z',
      });

      const b = await request(ctx.app)
        .post('/api/receipts')
        .attach('images', fakeImageBytes('same-vendor-2'), { filename: 'b.jpg', contentType: 'image/jpeg' });
      await request(ctx.app).put(`/api/receipts/${b.body[0].id}`).send({
        vendor: 'Costco',
        total_amount: 88.88,
        receipt_date: '2024-06-01T00:00:00.000Z',
      });

      const res = await request(ctx.app).get(`/api/receipts/${b.body[0].id}/duplicates`);
      expect(res.body.warnings.length).toBeGreaterThan(0);
    });

    it('does not flag the same vendor/total on a different date', async () => {
      const a = await request(ctx.app)
        .post('/api/receipts')
        .attach('images', fakeImageBytes('diff-date-1'), { filename: 'a.jpg', contentType: 'image/jpeg' });
      await request(ctx.app).put(`/api/receipts/${a.body[0].id}`).send({
        vendor: 'Canadian Tire',
        total_amount: 15.0,
        receipt_date: '2024-01-01T00:00:00.000Z',
      });

      const b = await request(ctx.app)
        .post('/api/receipts')
        .attach('images', fakeImageBytes('diff-date-2'), { filename: 'b.jpg', contentType: 'image/jpeg' });
      await request(ctx.app).put(`/api/receipts/${b.body[0].id}`).send({
        vendor: 'Canadian Tire',
        total_amount: 15.0,
        receipt_date: '2024-02-01T00:00:00.000Z',
      });

      const res = await request(ctx.app).get(`/api/receipts/${b.body[0].id}/duplicates`);
      expect(res.body.warnings).toEqual([]);
    });

    it('404s for an unknown receipt', async () => {
      const res = await request(ctx.app).get('/api/receipts/nope/duplicates');
      expect(res.status).toBe(404);
    });
  });

  describe('queue status counts', () => {
    it('tallies receipts by pipeline stage', async () => {
      // Baseline snapshot, then create one receipt of a known status and
      // confirm the "captured" bucket increments by exactly one — this
      // avoids depending on exact totals left over from earlier tests.
      const before = await request(ctx.app).get('/api/receipts/queue/status');
      await request(ctx.app)
        .post('/api/receipts')
        .attach('images', fakeImageBytes('queue-count'), { filename: 'a.jpg', contentType: 'image/jpeg' });
      const after = await request(ctx.app).get('/api/receipts/queue/status');

      expect(after.body.captured).toBe(before.body.captured + 1);
      expect(Object.keys(after.body).sort()).toEqual(['captured', 'failed', 'pending', 'uploaded'].sort());
    });
  });
});
