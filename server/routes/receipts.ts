import { Router, Request, Response } from 'express';
import multer from 'multer';
import { v4 as uuid } from 'uuid';
import fs from 'fs';
import path from 'path';
import { getDb, type ReceiptRow, type ReceiptStatus } from '../db/db.js';
import { StorageService } from '../receipts/storage.js';
import { ClaudeAPIError } from '../integrations/claude.js';
import { extractAndFile, triggerQueue } from '../receipts/extract-queue.js';
import { rateLimited } from '../platform/rate-limit.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed.'));
  },
});

const RECEIPT_STATUSES: ReceiptStatus[] = ['captured', 'extracted', 'reviewed', 'needsAttention'];

/** Any parseable date → its 'YYYY-MM-DD', taking a leading ISO date as written. */
function toYmd(value: string): string {
  const m = /^\d{4}-\d{2}-\d{2}/.exec(String(value));
  return m ? m[0] : new Date(value).toISOString().slice(0, 10);
}

export function receiptRoutes(storage: StorageService): Router {
  const router = Router();
  const db = getDb();

  // ── Prepared statements ──
  const insertReceipt = db.prepare(`
    INSERT INTO receipts (
      id, primary_image, additional_images, receipt_date, capture_date,
      month_folder, status, image_hash, created_at, updated_at
    ) VALUES (
      @id, @primary_image, @additional_images, @receipt_date, @capture_date,
      @month_folder, @status, @image_hash, @created_at, @updated_at
    )
  `);

  // Newest receipt date first — the date printed on the receipt once
  // Claude has read it, the upload time until then.
  const selectAll = db.prepare(`
    SELECT * FROM receipts ORDER BY receipt_date DESC, created_at DESC
  `);

  const selectById = db.prepare(`SELECT * FROM receipts WHERE id = ?`);

  const deleteById = db.prepare(`DELETE FROM receipts WHERE id = ?`);

  const updateReceipt = db.prepare(`
    UPDATE receipts SET
      receipt_date = COALESCE(@receipt_date, receipt_date),
      month_folder = @month_folder,
      primary_image = @primary_image,
      additional_images = @additional_images,
      vendor = @vendor,
      summary = @summary,
      total_amount = @total_amount,
      tax_amount = @tax_amount,
      currency = COALESCE(@currency, currency),
      status = COALESCE(@status, status),
      updated_at = @updated_at
    WHERE id = @id
  `);

  // ── POST /api/receipts — Upload image(s), create receipt ──
  // Each upload is read by Claude straight away (extract-queue.ts), so
  // this is a paid-API doorway and is rate limited like one.
  router.post('/', rateLimited('receipt-upload', 30, 60_000), upload.array('images', 10), (req: Request, res: Response): void => {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      res.status(400).json({ error: 'No images uploaded.' });
      return;
    }

    const now = new Date();
    const isoNow = now.toISOString();
    const results: ReceiptRow[] = [];

    for (const file of files) {
      const saved = storage.saveReceiptImages([{ buffer: file.buffer, mimetype: file.mimetype }], now);
      const id = uuid();
      const month = storage.monthFolder(now);
      const hash = storage.computeImageHash(saved.primaryPath);

      const row = {
        id,
        primary_image: saved.primaryPath,
        additional_images: JSON.stringify(saved.additionalPaths),
        receipt_date: isoNow,
        capture_date: isoNow,
        month_folder: month,
        status: 'captured' as const,
        image_hash: hash,
        created_at: isoNow,
        updated_at: isoNow,
      };

      insertReceipt.run(row);

      // Save a minimal sidecar
      storage.saveSidecar(saved.primaryPath, {
        status: 'captured',
        capturedAt: isoNow,
      });

      results.push(selectById.get(id) as ReceiptRow);
    }

    // Read them now rather than on the next minute's poll. The response
    // doesn't wait: the client sees `captured` and refreshes.
    triggerQueue();

    res.status(201).json(results);
  });

  // ── GET /api/receipts — List all receipts ──
  router.get('/', (req: Request, res: Response): void => {
    const { search, status } = req.query;
    let rows = selectAll.all() as ReceiptRow[];

    if (typeof status === 'string' && status) {
      rows = rows.filter((r) => r.status === status);
    }

    if (typeof search === 'string' && search) {
      const q = search.toLowerCase();
      rows = rows.filter(
        (r) =>
          (r.vendor?.toLowerCase().includes(q) ?? false) ||
          (r.summary?.toLowerCase().includes(q) ?? false) ||
          r.status.toLowerCase().includes(q) ||
          (r.total_amount != null && r.total_amount.toFixed(2).includes(q)),
      );
    }

    // Group by the receipt's own month (not the folder it happens to sit
    // in, which lagged behind until the old review step re-filed it).
    const grouped: Record<string, ReceiptRow[]> = {};
    for (const r of rows) {
      (grouped[r.receipt_date.slice(0, 7)] ??= []).push(r);
    }

    // Sort months newest first
    const months = Object.keys(grouped).sort().reverse();
    const result = months.map((m) => ({
      month: m,
      receipts: grouped[m],
    }));

    res.json(result);
  });

  // ── GET /api/receipts/summary — Counts for the list's status bar ──
  // Must be registered before GET /:id, which would otherwise take
  // "summary" as an id.
  router.get('/summary', (_req: Request, res: Response): void => {
    const row = db
      .prepare(
        `SELECT
           SUM(status = 'captured')                                  AS processing,
           SUM(status = 'extracted' AND COALESCE(confidence, '') <> 'high') AS toCheck,
           SUM(status = 'needsAttention')                            AS unreadable
         FROM receipts`,
      )
      .get() as { processing: number | null; toCheck: number | null; unreadable: number | null };

    res.json({
      processing: row.processing ?? 0,
      toCheck: row.toCheck ?? 0,
      unreadable: row.unreadable ?? 0,
    });
  });

  // ── GET /api/receipts/:id — Single receipt ──
  router.get('/:id', (req: Request, res: Response): void => {
    const row = selectById.get(req.params.id) as ReceiptRow | undefined;
    if (!row) {
      res.status(404).json({ error: 'Receipt not found.' });
      return;
    }
    res.json(row);
  });

  // ── GET /api/receipts/:id/image — The receipt photo, by id ──
  // A stable link to the original image: unlike `/images/<path>`, it
  // survives the file being re-filed when the date or vendor changes.
  // `?download=1` saves it under its on-disk name
  // (e.g. 2026-08-14_staples_1a2b3c4d.jpg). `?page=N` for extra pages.
  router.get('/:id/image', (req: Request, res: Response): void => {
    const row = selectById.get(req.params.id) as ReceiptRow | undefined;
    if (!row) {
      res.status(404).json({ error: 'Receipt not found.' });
      return;
    }

    const pages = [row.primary_image, ...(JSON.parse(row.additional_images || '[]') as string[])];
    const page = req.query.page === undefined ? 1 : Number(req.query.page);
    const rel = Number.isInteger(page) ? pages[page - 1] : undefined;
    const abs = rel ? storage.absolutePath(rel) : null;
    if (!abs || !fs.existsSync(abs)) {
      res.status(404).json({ error: 'Image not found.' });
      return;
    }

    if (req.query.download) res.download(path.resolve(abs), path.basename(rel!));
    else res.sendFile(path.resolve(abs));
  });

  // ── DELETE /api/receipts/:id — Delete receipt + files ──
  router.delete('/:id', (req: Request, res: Response): void => {
    const row = selectById.get(req.params.id) as ReceiptRow | undefined;
    if (!row) {
      res.status(404).json({ error: 'Receipt not found.' });
      return;
    }

    const additional: string[] = JSON.parse(row.additional_images || '[]');
    // Sidecars first: deleteReceiptFiles checks whether the month folder is
    // empty right after removing each image, so a lingering sidecar file
    // would make it look non-empty and skip the folder cleanup.
    storage.deleteSidecarFiles(row.primary_image, additional);
    storage.deleteReceiptFiles(row.primary_image, additional);
    deleteById.run(row.id);

    res.json({ deleted: true });
  });

  // ── POST /api/receipts/:id/extract — Read (or re-read) now ──
  // Normally the extract queue does this on upload. This is the manual
  // "Try again" for a receipt Claude couldn't read, and waits for the
  // answer so the screen can show it.
  router.post('/:id/extract', rateLimited('receipt-extract', 20, 60_000), async (req: Request, res: Response): Promise<void> => {
    const row = selectById.get(req.params.id) as ReceiptRow | undefined;
    if (!row) {
      res.status(404).json({ error: 'Receipt not found.' });
      return;
    }

    const apiKey = process.env.CLAUDE_API_KEY;
    if (!apiKey) {
      res.status(400).json({ error: 'No Claude API key configured. Add it in Settings.' });
      return;
    }

    try {
      res.json(await extractAndFile(storage, row.id, apiKey));
    } catch (err) {
      if (err instanceof ClaudeAPIError) {
        res.status(err.code === 'rate_limited' ? 429 : 400).json({
          error: err.message,
          code: err.code,
          retryAfter: err.retryAfter,
        });
        return;
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── PUT /api/receipts/:id — Update receipt fields (review) ──
  router.put('/:id', (req: Request, res: Response): void => {
    const row = selectById.get(req.params.id) as ReceiptRow | undefined;
    if (!row) {
      res.status(404).json({ error: 'Receipt not found.' });
      return;
    }

    const {
      receipt_date,
      vendor,
      summary,
      total_amount,
      tax_amount,
      currency,
      status,
    } = req.body;

    if (receipt_date && Number.isNaN(new Date(receipt_date).getTime())) {
      res.status(400).json({ error: 'Invalid receipt_date.' });
      return;
    }
    if (status && !RECEIPT_STATUSES.includes(status)) {
      res.status(400).json({ error: 'Invalid status.' });
      return;
    }

    const now = new Date().toISOString();

    const supplied = (field: string): boolean =>
      Object.prototype.hasOwnProperty.call(req.body, field);

    // Re-file the images if the date or vendor changed, so the folder on
    // disk keeps matching what the list shows.
    const nextDate = receipt_date ? toYmd(receipt_date) : row.receipt_date.slice(0, 10);
    const nextVendor = supplied('vendor') ? (vendor ?? null) : row.vendor;
    const primaryImage = storage.refileReceipt(row.primary_image, nextDate, nextVendor);
    const additionalImages = JSON.stringify(
      (JSON.parse(row.additional_images || '[]') as string[]).map((p) =>
        storage.refileReceipt(p, nextDate, nextVendor),
      ),
    );
    const monthFolder = nextDate.slice(0, 7);

    // Only fields actually present in the body are written. Previously
    // these four were coerced to null whenever they were absent, so a
    // partial update (e.g. just {status}) silently wiped the extracted
    // vendor and amounts. Sending an explicit null still clears
    // a field; omitting it now leaves it alone, matching how
    // receipt_date/currency/status already behaved.

    updateReceipt.run({
      id: row.id,
      receipt_date: receipt_date ? nextDate + 'T00:00:00.000Z' : null,
      month_folder: monthFolder,
      primary_image: primaryImage,
      additional_images: additionalImages,
      vendor: supplied('vendor') ? (vendor ?? null) : row.vendor,
      summary: supplied('summary') ? (summary ?? null) : row.summary,
      total_amount: supplied('total_amount') ? (total_amount ?? null) : row.total_amount,
      tax_amount: supplied('tax_amount') ? (tax_amount ?? null) : row.tax_amount,
      currency: currency || null,
      status: status || null,
      updated_at: now,
    });

    // Operator checked it (status → reviewed): record their values in the
    // sidecar, so the folder on disk carries the corrected data too.
    if (status === 'reviewed') {
      storage.saveSidecar(primaryImage, {
        status: 'reviewed',
        capturedAt: row.capture_date,
        reviewedAt: now,
        reviewed: {
          receiptDate: receipt_date || row.receipt_date,
          vendor: vendor ?? row.vendor,
          summaryDescription: summary ?? row.summary,
          total: total_amount ?? row.total_amount,
          taxAmount: tax_amount ?? row.tax_amount,
          currency: currency || row.currency || 'CAD',
        },
      });
    }

    const updated = selectById.get(row.id) as ReceiptRow;
    res.json(updated);
  });

  // ── GET /api/receipts/:id/duplicates — Check for duplicates ──
  router.get('/:id/duplicates', (req: Request, res: Response): void => {
    const row = selectById.get(req.params.id) as ReceiptRow | undefined;
    if (!row) {
      res.status(404).json({ error: 'Receipt not found.' });
      return;
    }

    const warnings: string[] = [];

    // Check by image hash
    if (row.image_hash) {
      const hashMatch = db
        .prepare(`SELECT id, vendor FROM receipts WHERE image_hash = ? AND id != ?`)
        .get(row.image_hash, row.id) as { id: string; vendor: string | null } | undefined;

      if (hashMatch) {
        warnings.push(
          `This image matches an existing receipt (${hashMatch.vendor || 'unknown vendor'}).`,
        );
      }
    }

    // Check by date + vendor + total
    if (row.vendor && row.total_amount != null) {
      const dateStr = row.receipt_date.slice(0, 10);
      const match = db
        .prepare(
          `SELECT id, vendor FROM receipts
           WHERE vendor = ? AND total_amount = ? AND substr(receipt_date, 1, 10) = ? AND id != ?`,
        )
        .get(row.vendor, row.total_amount, dateStr, row.id) as
        | { id: string; vendor: string }
        | undefined;

      if (match) {
        warnings.push(
          `A receipt from ${match.vendor} for the same amount on the same date already exists.`,
        );
      }
    }

    res.json({ warnings });
  });

  return router;
}
