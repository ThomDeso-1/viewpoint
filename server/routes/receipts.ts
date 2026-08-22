import { Router, Request, Response } from 'express';
import multer from 'multer';
import { v4 as uuid } from 'uuid';
import path from 'path';
import { getDb, type ReceiptRow } from '../db/db.js';
import { StorageService } from '../services/storage.js';
import { extractReceipt, ClaudeAPIError } from '../services/claude.js';
import { retryReceipt, retryAll, processQueue } from '../services/upload-queue.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed.'));
  },
});

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
  router.post('/', upload.array('images', 10), (req: Request, res: Response): void => {
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      res.status(400).json({ error: 'No images uploaded.' });
      return;
    }

    const now = new Date();
    const isoNow = now.toISOString();
    const results: ReceiptRow[] = [];

    for (const file of files) {
      const buffers = [file.buffer];
      const saved = storage.saveReceiptImages(buffers, now);
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

    // Group by month
    const grouped: Record<string, ReceiptRow[]> = {};
    for (const r of rows) {
      (grouped[r.month_folder] ??= []).push(r);
    }

    // Sort months newest first
    const months = Object.keys(grouped).sort().reverse();
    const result = months.map((m) => ({
      month: m,
      receipts: grouped[m],
    }));

    res.json(result);
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

  // ── DELETE /api/receipts/:id — Delete receipt + files ──
  router.delete('/:id', (req: Request, res: Response): void => {
    const row = selectById.get(req.params.id) as ReceiptRow | undefined;
    if (!row) {
      res.status(404).json({ error: 'Receipt not found.' });
      return;
    }

    const additional: string[] = JSON.parse(row.additional_images || '[]');
    storage.deleteReceiptFiles(row.primary_image, additional);
    storage.deleteSidecarFiles(row.primary_image, additional);
    deleteById.run(row.id);

    res.json({ deleted: true });
  });

  // ── POST /api/receipts/:id/extract — Run Claude vision extraction ──
  router.post('/:id/extract', async (req: Request, res: Response): Promise<void> => {
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

    // Collect all image paths
    const additional: string[] = JSON.parse(row.additional_images || '[]');
    const imagePaths = [row.primary_image, ...additional].map((p) =>
      path.resolve(storage.absolutePath(p)),
    );

    try {
      const { result, rawJSON } = await extractReceipt(imagePaths, apiKey);
      const now = new Date().toISOString();
      const totalTax = result.taxes.reduce((sum, t) => sum + t.amount, 0);

      db.prepare(`
        UPDATE receipts SET
          vendor = @vendor,
          summary = @summary,
          total_amount = @total_amount,
          tax_amount = @tax_amount,
          currency = @currency,
          extracted_json = @extracted_json,
          receipt_date = @receipt_date,
          status = 'extracted',
          updated_at = @updated_at
        WHERE id = @id
      `).run({
        id: row.id,
        vendor: result.vendor,
        summary: result.summary_description,
        total_amount: result.total,
        tax_amount: totalTax,
        currency: result.currency,
        extracted_json: rawJSON,
        receipt_date: result.receipt_date + 'T00:00:00.000Z',
        updated_at: now,
      });

      // Update sidecar
      storage.saveSidecar(row.primary_image, {
        status: 'extracted',
        capturedAt: row.capture_date,
        extractedAt: now,
        extraction: result,
      });

      const updated = selectById.get(row.id) as ReceiptRow;
      res.json(updated);
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

    const now = new Date().toISOString();

    // Re-file images into a different month folder if the receipt date moved.
    let monthFolder = row.month_folder;
    let primaryImage = row.primary_image;
    let additionalImages = row.additional_images;

    if (receipt_date) {
      const newDate = new Date(receipt_date);
      const newMonth = storage.monthFolder(newDate);
      if (newMonth !== row.month_folder) {
        const additional: string[] = JSON.parse(row.additional_images || '[]');
        primaryImage = storage.moveReceiptFileSet(row.primary_image, newDate);
        additionalImages = JSON.stringify(
          additional.map((p) => storage.moveReceiptFileSet(p, newDate)),
        );
        monthFolder = newMonth;
      }
    }

    updateReceipt.run({
      id: row.id,
      receipt_date: receipt_date || null,
      month_folder: monthFolder,
      primary_image: primaryImage,
      additional_images: additionalImages,
      vendor: vendor ?? null,
      summary: summary ?? null,
      total_amount: total_amount ?? null,
      tax_amount: tax_amount ?? null,
      currency: currency || null,
      status: status || null,
      updated_at: now,
    });

    // If approving (status → reviewed), update sidecar and trigger upload queue
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

      // Kick off Wave upload queue
      processQueue().catch(() => {});
    }

    const updated = selectById.get(row.id) as ReceiptRow;
    res.json(updated);
  });

  // ── POST /api/receipts/:id/retry — Retry a failed upload ──
  router.post('/:id/retry', (req: Request, res: Response): void => {
    const row = selectById.get(req.params.id) as ReceiptRow | undefined;
    if (!row) {
      res.status(404).json({ error: 'Receipt not found.' });
      return;
    }
    retryReceipt(row.id);
    res.json({ success: true });
  });

  // ── POST /api/receipts/retry-all — Retry all failed uploads ──
  router.post('/retry-all', (_req: Request, res: Response): void => {
    retryAll();
    res.json({ success: true });
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

  // ── GET /api/queue/status — Upload queue counts ──
  router.get('/queue/status', (_req: Request, res: Response): void => {
    const count = (status: string | string[]) => {
      const statuses = Array.isArray(status) ? status : [status];
      const placeholders = statuses.map(() => '?').join(',');
      const row = db
        .prepare(`SELECT COUNT(*) as c FROM receipts WHERE status IN (${placeholders})`)
        .get(...statuses) as { c: number };
      return row.c;
    };

    res.json({
      uploaded: count('uploaded'),
      pending: count(['reviewed', 'extracted']),
      failed: count(['failed', 'needsAttention']),
      captured: count('captured'),
    });
  });

  return router;
}
