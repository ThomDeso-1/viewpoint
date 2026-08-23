import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StorageService } from '../server/services/storage.js';

/**
 * Spec (CONVERSION-PLAN.md "Image storage", "Sidecar JSON files"):
 *  - Images live in `Receipts/YYYY-MM/` monthly folders.
 *  - Each image has a sidecar `.json` file with the same basename.
 *  - Moving a receipt to a new month moves both the image and its sidecar.
 *  - Deleting a receipt's files cleans up now-empty month folders.
 *  - A saved file's extension matches its real mime type (not just a
 *    hardcoded ".jpg"), because extraction later infers the Claude vision
 *    media_type from the saved file's extension — see claude.ts.
 */
function img(seed: string, mimetype = 'image/jpeg') {
  return { buffer: Buffer.from(seed), mimetype };
}

describe('StorageService', () => {
  let dir: string;
  let storage: StorageService;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-storage-test-'));
    storage = new StorageService(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('names the month folder YYYY-MM', () => {
    expect(storage.monthFolder(new Date('2026-01-05T12:00:00Z'))).toBe('2026-01');
    expect(storage.monthFolder(new Date('2026-11-30T12:00:00Z'))).toBe('2026-11');
  });

  it('formats the date string as YYYY-MM-DD', () => {
    expect(storage.dateString(new Date('2026-03-07T12:00:00Z'))).toBe('2026-03-07');
  });

  it('saves an image into its monthly folder and returns a relative path', () => {
    const date = new Date('2026-05-15T12:00:00Z');
    const { primaryPath, additionalPaths } = storage.saveReceiptImages([img('img1')], date);
    expect(primaryPath.startsWith('2026-05/')).toBe(true);
    expect(additionalPaths).toEqual([]);
    expect(fs.existsSync(storage.absolutePath(primaryPath))).toBe(true);
  });

  it('saves multiple pages with distinct filenames sharing a batch id', () => {
    const date = new Date('2026-05-15T12:00:00Z');
    const { primaryPath, additionalPaths } = storage.saveReceiptImages(
      [img('page1'), img('page2')],
      date,
    );
    expect(additionalPaths).toHaveLength(1);
    expect(fs.existsSync(storage.absolutePath(primaryPath))).toBe(true);
    expect(fs.existsSync(storage.absolutePath(additionalPaths[0]))).toBe(true);
    expect(primaryPath).not.toBe(additionalPaths[0]);
  });

  describe('saved file extension matches the real image format', () => {
    const date = new Date('2026-05-15T12:00:00Z');

    it('keeps .jpg for image/jpeg', () => {
      const { primaryPath } = storage.saveReceiptImages([img('x', 'image/jpeg')], date);
      expect(primaryPath.endsWith('.jpg')).toBe(true);
    });

    it('uses .png for image/png', () => {
      const { primaryPath } = storage.saveReceiptImages([img('x', 'image/png')], date);
      expect(primaryPath.endsWith('.png')).toBe(true);
    });

    it('uses .webp for image/webp', () => {
      const { primaryPath } = storage.saveReceiptImages([img('x', 'image/webp')], date);
      expect(primaryPath.endsWith('.webp')).toBe(true);
    });

    it('uses .gif for image/gif', () => {
      const { primaryPath } = storage.saveReceiptImages([img('x', 'image/gif')], date);
      expect(primaryPath.endsWith('.gif')).toBe(true);
    });

    it('falls back to .jpg for an unrecognized image mime type', () => {
      const { primaryPath } = storage.saveReceiptImages([img('x', 'image/bmp')], date);
      expect(primaryPath.endsWith('.jpg')).toBe(true);
    });

    it('gives each page in a multi-page upload its own matching extension', () => {
      const { primaryPath, additionalPaths } = storage.saveReceiptImages(
        [img('page1', 'image/png'), img('page2', 'image/webp')],
        date,
      );
      expect(primaryPath.endsWith('.png')).toBe(true);
      expect(additionalPaths[0].endsWith('.webp')).toBe(true);
    });
  });

  it('computes a stable SHA-256 hash, and identical bytes hash identically', () => {
    const date = new Date();
    const a = storage.saveReceiptImages([img('same-content')], date);
    const b = storage.saveReceiptImages([img('same-content')], date);
    const hashA = storage.computeImageHash(a.primaryPath);
    const hashB = storage.computeImageHash(b.primaryPath);
    expect(hashA).toBe(hashB);
    expect(hashA).toMatch(/^[0-9a-f]{64}$/);
  });

  it('different bytes hash differently', () => {
    const date = new Date();
    const a = storage.saveReceiptImages([img('content-a')], date);
    const b = storage.saveReceiptImages([img('content-b')], date);
    expect(storage.computeImageHash(a.primaryPath)).not.toBe(storage.computeImageHash(b.primaryPath));
  });

  it('returns null hash for a path that does not exist', () => {
    expect(storage.computeImageHash('2026-01/missing.jpg')).toBeNull();
  });

  it('writes and reads back a sidecar JSON file alongside the image', () => {
    const date = new Date('2026-05-15T12:00:00Z');
    const { primaryPath } = storage.saveReceiptImages([img('img')], date);
    storage.saveSidecar(primaryPath, { status: 'captured', capturedAt: '2026-05-15T12:00:00Z' });

    const loaded = storage.loadSidecar(primaryPath) as any;
    expect(loaded.status).toBe('captured');
  });

  it('returns null when loading a sidecar that was never written', () => {
    expect(storage.loadSidecar('2026-01/nope.jpg')).toBeNull();
  });

  it('moving a receipt to a new month relocates both image and sidecar', () => {
    const oldDate = new Date('2026-01-10T12:00:00Z');
    const { primaryPath } = storage.saveReceiptImages([img('img')], oldDate);
    storage.saveSidecar(primaryPath, { status: 'captured' });

    const newDate = new Date('2026-07-20T12:00:00Z');
    const newPath = storage.moveReceiptFileSet(primaryPath, newDate);

    expect(newPath.startsWith('2026-07/')).toBe(true);
    expect(fs.existsSync(storage.absolutePath(primaryPath))).toBe(false);
    expect(fs.existsSync(storage.absolutePath(newPath))).toBe(true);
    expect(storage.loadSidecar(newPath)).toEqual({ status: 'captured' });
  });

  it('moving to the same month is a no-op that keeps the same path', () => {
    const date = new Date('2026-01-10T12:00:00Z');
    const { primaryPath } = storage.saveReceiptImages([img('img')], date);
    const newPath = storage.moveReceiptImage(primaryPath, new Date('2026-01-25T00:00:00Z'));
    expect(newPath).toBe(primaryPath);
    expect(fs.existsSync(storage.absolutePath(primaryPath))).toBe(true);
  });

  it('cleans up the old month folder once it is empty after a move', () => {
    const oldDate = new Date('2026-02-01T12:00:00Z');
    const { primaryPath } = storage.saveReceiptImages([img('img')], oldDate);
    const oldFolder = path.dirname(storage.absolutePath(primaryPath));
    expect(fs.existsSync(oldFolder)).toBe(true);

    storage.moveReceiptImage(primaryPath, new Date('2026-08-01T12:00:00Z'));
    expect(fs.existsSync(oldFolder)).toBe(false);
  });

  it('does not remove the old month folder if other receipts still live there', () => {
    const oldDate = new Date('2026-02-01T12:00:00Z');
    const a = storage.saveReceiptImages([img('img-a')], oldDate);
    const b = storage.saveReceiptImages([img('img-b')], oldDate);
    const oldFolder = path.dirname(storage.absolutePath(a.primaryPath));

    storage.moveReceiptImage(a.primaryPath, new Date('2026-08-01T12:00:00Z'));
    expect(fs.existsSync(oldFolder)).toBe(true);
    expect(fs.existsSync(storage.absolutePath(b.primaryPath))).toBe(true);
  });

  it('deleting a receipt removes its image and sidecar, and cleans up an empty month folder', () => {
    const date = new Date('2026-04-01T12:00:00Z');
    const { primaryPath } = storage.saveReceiptImages([img('img')], date);
    storage.saveSidecar(primaryPath, { status: 'captured' });
    const folder = path.dirname(storage.absolutePath(primaryPath));

    // Sidecars must go first: deleteReceiptFiles checks whether the month
    // folder is empty right after unlinking each image, so a lingering
    // sidecar file would make it look non-empty and skip the cleanup.
    storage.deleteSidecarFiles(primaryPath, []);
    storage.deleteReceiptFiles(primaryPath, []);

    expect(fs.existsSync(storage.absolutePath(primaryPath))).toBe(false);
    expect(storage.loadSidecar(primaryPath)).toBeNull();
    expect(fs.existsSync(folder)).toBe(false);
  });

  it('deletes all pages of a multi-page receipt', () => {
    const date = new Date('2026-04-01T12:00:00Z');
    const { primaryPath, additionalPaths } = storage.saveReceiptImages(
      [img('p1'), img('p2')],
      date,
    );
    storage.deleteReceiptFiles(primaryPath, additionalPaths);
    expect(fs.existsSync(storage.absolutePath(primaryPath))).toBe(false);
    expect(fs.existsSync(storage.absolutePath(additionalPaths[0]))).toBe(false);
  });
});
