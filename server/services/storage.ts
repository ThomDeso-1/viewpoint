import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/**
 * Manages receipt image files on disk — saving into monthly folders,
 * loading, deleting, and computing hashes.
 *
 * Direct port of StorageService.swift.
 */
export class StorageService {
  private receiptsRoot: string;

  constructor(dataDir: string) {
    this.receiptsRoot = path.join(dataDir, 'Receipts');
    fs.mkdirSync(this.receiptsRoot, { recursive: true });
  }

  /** Absolute path for a relative receipt path. */
  absolutePath(relativePath: string): string {
    return path.join(this.receiptsRoot, relativePath);
  }

  /** "2026-08" style folder name for a Date. */
  monthFolder(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  }

  /** "2026-08-14" style date string. */
  dateString(date: Date): string {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  /** Ensure a month subfolder exists and return its absolute path. */
  ensureMonthFolder(date: Date): string {
    const folder = path.join(this.receiptsRoot, this.monthFolder(date));
    fs.mkdirSync(folder, { recursive: true });
    return folder;
  }

  /**
   * Save uploaded image buffer(s) into the correct monthly folder.
   * Returns relative paths (from receiptsRoot).
   */
  saveReceiptImages(
    buffers: Buffer[],
    date: Date,
  ): { primaryPath: string; additionalPaths: string[] } {
    const month = this.monthFolder(date);
    const folderAbs = this.ensureMonthFolder(date);
    const dateStr = this.dateString(date);
    const batchId = crypto.randomUUID().slice(0, 8);

    const relativePaths: string[] = [];

    for (let i = 0; i < buffers.length; i++) {
      const pageSuffix = buffers.length > 1 ? `_p${i + 1}` : '';
      const fileName = `${dateStr}_${batchId}${pageSuffix}.jpg`;
      const filePath = path.join(folderAbs, fileName);
      fs.writeFileSync(filePath, buffers[i]);
      relativePaths.push(`${month}/${fileName}`);
    }

    return {
      primaryPath: relativePaths[0],
      additionalPaths: relativePaths.slice(1),
    };
  }

  /** Compute SHA-256 hash of an image file. */
  computeImageHash(relativePath: string): string | null {
    const abs = this.absolutePath(relativePath);
    if (!fs.existsSync(abs)) return null;
    const data = fs.readFileSync(abs);
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /** Delete image files and clean up empty month folders. */
  deleteReceiptFiles(primaryPath: string, additionalPaths: string[]): void {
    const allPaths = [primaryPath, ...additionalPaths];
    for (const p of allPaths) {
      const abs = this.absolutePath(p);
      if (fs.existsSync(abs)) fs.unlinkSync(abs);

      // Clean empty month folder
      const folder = path.dirname(abs);
      try {
        const contents = fs.readdirSync(folder);
        if (contents.length === 0) fs.rmdirSync(folder);
      } catch {
        // ignore
      }
    }
  }

  /** Move an image to a different month folder. Returns new relative path. */
  moveReceiptImage(oldPath: string, newDate: Date): string {
    const oldAbs = this.absolutePath(oldPath);
    const newMonth = this.monthFolder(newDate);
    this.ensureMonthFolder(newDate);
    const fileName = path.basename(oldPath);
    const newRelative = `${newMonth}/${fileName}`;
    const newAbs = this.absolutePath(newRelative);

    if (oldPath === newRelative) return oldPath;

    fs.renameSync(oldAbs, newAbs);

    // Clean up now-empty old month folder
    const oldFolder = path.dirname(oldAbs);
    try {
      const contents = fs.readdirSync(oldFolder);
      if (contents.length === 0) fs.rmdirSync(oldFolder);
    } catch {
      // ignore
    }

    return newRelative;
  }

  /** Move an image and its sidecar JSON together to a different month folder. */
  moveReceiptFileSet(oldPath: string, newDate: Date): string {
    const oldSidecar = this.sidecarPath(oldPath);
    const hasSidecar = fs.existsSync(oldSidecar);
    const newPath = this.moveReceiptImage(oldPath, newDate);

    if (hasSidecar) {
      const newSidecar = this.sidecarPath(newPath);
      if (oldSidecar !== newSidecar) fs.renameSync(oldSidecar, newSidecar);
    }

    return newPath;
  }

  // ── Sidecar files ──

  private sidecarPath(imagePath: string): string {
    const abs = this.absolutePath(imagePath);
    const parsed = path.parse(abs);
    return path.join(parsed.dir, `${parsed.name}.json`);
  }

  saveSidecar(imagePath: string, data: object): void {
    const p = this.sidecarPath(imagePath);
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
  }

  loadSidecar(imagePath: string): object | null {
    const p = this.sidecarPath(imagePath);
    if (!fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch {
      return null;
    }
  }

  deleteSidecarFiles(primaryPath: string, additionalPaths: string[]): void {
    for (const p of [primaryPath, ...additionalPaths]) {
      const sc = this.sidecarPath(p);
      if (fs.existsSync(sc)) fs.unlinkSync(sc);
    }
  }
}
