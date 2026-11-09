import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  cloudDir,
  describeCloudError,
  ensureCloudFolder,
  previousCloudDir,
  setCloudError,
} from './cloud-folder.js';
import { updateEnvConfig } from '../platform/env-config.js';

/**
 * File extension to save an uploaded image under, based on its real mime
 * type — must stay in sync with the extension → media_type mapping in
 * claude.ts, since extraction infers the Claude vision media type from
 * this saved file's extension.
 */
function extensionForMimeType(mimetype: string): string {
  switch (mimetype) {
    case 'image/png':
      return '.png';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    default:
      return '.jpg';
  }
}

/** "Staples Business Depot #123" → "staples-business-depot-123", capped. */
function vendorSlug(vendor: string | null): string {
  return (vendor ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

/**
 * Manages receipt image files on disk — saving into monthly folders,
 * loading, deleting, and computing hashes.
 *
 * A file can sit in one of three roots, and callers never need to know
 * which. New files are always written to the local root, so a cloud
 * service being offline can't fail an upload; syncToCloud then moves them
 * to the chosen cloud folder. The previous cloud folder only counts while
 * files are being moved out of it after the operator switches.
 *
 * Direct port of StorageService.swift.
 */
export class StorageService {
  private receiptsRoot: string;

  constructor(dataDir: string) {
    this.receiptsRoot = path.join(dataDir, 'Receipts');
    fs.mkdirSync(this.receiptsRoot, { recursive: true });
  }

  /** Every place a file may be, newest first. Resolved per call: the choice can change. */
  private roots(): string[] {
    return [this.receiptsRoot, cloudDir(), previousCloudDir()].filter((r): r is string => !!r);
  }

  /** Absolute path for a relative receipt path, wherever the file currently is. */
  absolutePath(relativePath: string): string {
    for (const root of this.roots()) {
      const abs = path.join(root, relativePath);
      if (fs.existsSync(abs)) return abs;
    }
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
   * Save uploaded image file(s) into the correct monthly folder. Each
   * file keeps the extension matching its real mime type — this matters
   * because extraction later infers the Claude vision `media_type` from
   * the saved file's extension, so a mismatch there would send an image
   * mislabeled as the wrong format.
   * Returns relative paths (from receiptsRoot).
   */
  saveReceiptImages(
    files: { buffer: Buffer; mimetype: string }[],
    date: Date,
  ): { primaryPath: string; additionalPaths: string[] } {
    const month = this.monthFolder(date);
    const folderAbs = this.ensureMonthFolder(date);
    const dateStr = this.dateString(date);
    const batchId = crypto.randomUUID().slice(0, 8);

    const relativePaths: string[] = [];

    for (let i = 0; i < files.length; i++) {
      const pageSuffix = files.length > 1 ? `_p${i + 1}` : '';
      const ext = extensionForMimeType(files[i].mimetype);
      const fileName = `${dateStr}_${batchId}${pageSuffix}${ext}`;
      const filePath = path.join(folderAbs, fileName);
      fs.writeFileSync(filePath, files[i].buffer);
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

  /** Remove a file from every root. A cloud failure mustn't block deleting the receipt. */
  private removeEverywhere(relativePath: string): void {
    for (const root of this.roots()) {
      const abs = path.join(root, relativePath);
      try {
        fs.rmSync(abs, { force: true });
        removeFolderIfEmpty(path.dirname(abs));
      } catch (err) {
        if (root === this.receiptsRoot) throw err;
      }
    }
  }

  /** Delete image files and clean up empty month folders. */
  deleteReceiptFiles(primaryPath: string, additionalPaths: string[]): void {
    for (const p of [primaryPath, ...additionalPaths]) this.removeEverywhere(p);
  }

  /**
   * Re-file an image (and its sidecar) under the receipt's own date and
   * vendor, e.g. `2026-08/2026-08-14_staples_1a2b3c4d.jpg`, so the
   * Receipts folder on disk reads like the in-app list — browsable in
   * Finder without the app. Returns the new relative path.
   *
   * Takes the `YYYY-MM-DD` string rather than a Date: the stored
   * receipt_date is UTC midnight, and turning that into a local Date put
   * the 1st of the month into the previous month's folder in Toronto.
   *
   * The random batch id (and `_pN` page suffix) from the original name is
   * kept, so two receipts from the same vendor on the same day can't
   * collide. Same target → no-op. Also a no-op when the image can't be
   * reached (cloud service signed out): the fields still save, and the
   * name catches up the next time the receipt is edited.
   */
  refileReceipt(oldPath: string, ymd: string, vendor: string | null): string {
    const month = ymd.slice(0, 7);
    const parsed = path.parse(oldPath);
    const token = parsed.name.match(/[0-9a-f]{8}(?:_p\d+)?$/)?.[0] ?? parsed.name;
    const slug = vendorSlug(vendor);
    const fileName = `${ymd}${slug ? `_${slug}` : ''}_${token}${parsed.ext}`;
    const newRelative = `${month}/${fileName}`;
    if (newRelative === oldPath) return oldPath;

    const roots = this.roots();
    if (!roots.some((root) => fs.existsSync(path.join(root, oldPath)))) return oldPath;
    // never overwrite another receipt
    if (roots.some((root) => fs.existsSync(path.join(root, newRelative)))) return oldPath;

    // A sidecar can briefly sit in a different root from its image: a fresh
    // one is written locally until the next sync moves it.
    for (const root of roots) {
      renameIfPresent(root, oldPath, newRelative);
      renameIfPresent(root, sidecarRelative(oldPath), sidecarRelative(newRelative));
    }

    return newRelative;
  }

  // ── Cloud storage ──

  /**
   * Move receipts to where the operator chose: the local copy is removed
   * once the cloud copy is confirmed, because the point is to free up this
   * Mac. Also empties the previous location after a switch.
   *
   * Stops at the first failure — they would all fail the same way — and
   * records it for the Receipts screen. Nothing is removed from a source
   * until its copy is verified, and the next pass picks up where this one
   * stopped.
   */
  async syncToCloud(imagePaths: string[]): Promise<void> {
    const target = cloudDir();
    const previous = previousCloudDir();
    if (!target && !previous) {
      setCloudError(null);
      return;
    }
    try {
      // Throws if a service is signed out or blocked. Essential for
      // `previous`: an unreadable folder looks empty, and clearing it on
      // that basis would orphan every receipt inside.
      if (target) ensureCloudFolder(target);
      if (previous) ensureCloudFolder(previous);

      const destination = target ?? this.receiptsRoot;
      for (const imagePath of imagePaths) {
        for (const rel of [imagePath, sidecarRelative(imagePath)]) {
          if (previous) await moveFile(path.join(previous, rel), path.join(destination, rel), false);
          if (target) await moveFile(path.join(this.receiptsRoot, rel), path.join(target, rel), true);
        }
      }

      if (previous) updateEnvConfig({ RECEIPTS_CLOUD_PREVIOUS_DIR: '' });
      setCloudError(null);
    } catch (err) {
      setCloudError(describeCloudError(err));
    }
  }

  /** How many of these images have not reached the chosen location yet. */
  countWaitingToMove(imagePaths: string[]): number {
    const target = cloudDir();
    const previous = previousCloudDir();
    return imagePaths.filter(
      (rel) =>
        (previous !== null && fs.existsSync(path.join(previous, rel))) ||
        (target !== null && fs.existsSync(path.join(this.receiptsRoot, rel))),
    ).length;
  }

  // ── Sidecar files ──

  /**
   * Always written locally, even for a receipt already in the cloud: a
   * signed-out service then can't lose an operator's review, and the next
   * sync moves it over the older cloud version.
   */
  saveSidecar(imagePath: string, data: object): void {
    const p = path.join(this.receiptsRoot, sidecarRelative(imagePath));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data, null, 2));
  }

  loadSidecar(imagePath: string): object | null {
    const p = this.absolutePath(sidecarRelative(imagePath));
    if (!fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch {
      return null;
    }
  }

  deleteSidecarFiles(primaryPath: string, additionalPaths: string[]): void {
    for (const p of [primaryPath, ...additionalPaths]) this.removeEverywhere(sidecarRelative(p));
  }
}

function sidecarRelative(imagePath: string): string {
  const parsed = path.parse(imagePath);
  return path.join(parsed.dir, `${parsed.name}.json`);
}

function renameIfPresent(root: string, from: string, to: string): void {
  const fromAbs = path.join(root, from);
  if (!fs.existsSync(fromAbs)) return;
  const toAbs = path.join(root, to);
  fs.mkdirSync(path.dirname(toAbs), { recursive: true });
  fs.renameSync(fromAbs, toAbs);
  removeFolderIfEmpty(path.dirname(fromAbs));
}

/**
 * Copy, verify, then remove the source. Async because a file iCloud has
 * offloaded downloads during the copy, which mustn't freeze the server.
 * `overwrite` is false when moving out of an old location, whose version
 * of a sidecar is older than anything already at the destination.
 */
async function moveFile(src: string, dest: string, overwrite: boolean): Promise<void> {
  if (!fs.existsSync(src)) return;
  if (!overwrite && fs.existsSync(dest)) {
    fs.rmSync(src, { force: true });
    removeFolderIfEmpty(path.dirname(src));
    return;
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // Write-then-rename, so a crash can't leave a truncated photo at `dest`.
  const tmp = `${dest}.tmp-${process.pid}`;
  try {
    await fs.promises.copyFile(src, tmp);
    fs.renameSync(tmp, dest);
  } finally {
    fs.rmSync(tmp, { force: true });
  }

  // The receipt was re-filed or deleted during the copy, so this name is stale.
  if (!fs.existsSync(src)) {
    fs.rmSync(dest, { force: true });
    return;
  }
  if (fs.statSync(src).size !== fs.statSync(dest).size) {
    throw new Error('copy verification failed');
  }
  fs.rmSync(src, { force: true });
  removeFolderIfEmpty(path.dirname(src));
}

function removeFolderIfEmpty(folder: string): void {
  try {
    if (fs.readdirSync(folder).length === 0) fs.rmdirSync(folder);
  } catch {
    // ignore
  }
}
