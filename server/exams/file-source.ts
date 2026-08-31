import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { resolveWithinRoot } from '../platform/paths.js';
import type { BatchExtractionInput } from '../integrations/claude.js';
import { xlsxToText } from './xlsx.js';
import { docxToText } from './docx.js';

/**
 * The patient-files folder source.
 *
 * The operator points `EXAM_REQUEST_SOURCE_DIR` at a folder — typically a
 * Dropbox / iCloud / Google Drive folder that a desktop app keeps synced
 * to this machine — and drops spreadsheets, PDFs or notes into it. The
 * scanner (`queue.scanSourceFolder`) walks it every minute, and this
 * module is the filesystem half of that: what counts as a file, how to
 * read one for extraction, and the content hash that decides whether a
 * file has already been seen.
 */

export const SUPPORTED_EXTENSIONS = new Set(['.docx', '.xlsx', '.csv', '.pdf', '.txt', '.eml']);

// A PDF is sent to Claude base64-encoded; keep the encoded request
// comfortably under the API's ~32 MB ceiling.
const DEFAULT_MAX_FILE_MB = 20;

/** Office keeps a `~$name.xlsx` lock file open next to an open workbook. */
function isJunk(name: string): boolean {
  return name.startsWith('.') || name.startsWith('~$') || name === 'Thumbs.db';
}

export function sourceDir(): string | null {
  const dir = process.env.EXAM_REQUEST_SOURCE_DIR?.trim();
  return dir || null;
}

export function maxFileBytes(): number {
  const mb = Number(process.env.EXAM_REQUEST_SOURCE_MAX_FILE_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_FILE_MB) * 1024 * 1024;
}

export interface SourceFile {
  /** Path relative to the configured folder — the scanner's idempotency key. */
  relativePath: string;
  absolutePath: string;
  size: number;
  /** ISO string — used as the exam request's `received_at`. */
  mtime: string;
  /** Lowercase extension, with the dot. */
  ext: string;
}

export interface FolderWalk {
  files: SourceFile[];
  /** Supported files skipped for exceeding the size cap. */
  tooLarge: string[];
}

export class SourceFolderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceFolderError';
  }
}

/**
 * Walks the folder recursively. Skips hidden files, Office lock files and
 * symlinks; keeps only supported extensions within the size cap.
 */
export function walkSourceDir(root: string): FolderWalk {
  const resolvedRoot = path.resolve(root);

  let rootStat: fs.Stats;
  try {
    rootStat = fs.statSync(resolvedRoot);
  } catch {
    throw new SourceFolderError(`The folder "${resolvedRoot}" does not exist or cannot be read.`);
  }
  if (!rootStat.isDirectory()) {
    throw new SourceFolderError(`"${resolvedRoot}" is not a folder.`);
  }

  const limit = maxFileBytes();
  const files: SourceFile[] = [];
  const tooLarge: string[] = [];

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // an unreadable sub-folder is skipped, not fatal
    }

    for (const entry of entries) {
      if (isJunk(entry.name)) continue;
      if (entry.isSymbolicLink()) continue;

      const absolutePath = resolveWithinRoot(resolvedRoot, path.join(dir, entry.name));

      if (entry.isDirectory()) {
        walk(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.has(ext)) continue;

      let stat: fs.Stats;
      try {
        stat = fs.statSync(absolutePath);
      } catch {
        continue;
      }

      const relativePath = path.relative(resolvedRoot, absolutePath);
      if (stat.size > limit) {
        tooLarge.push(relativePath);
        continue;
      }

      files.push({
        relativePath,
        absolutePath,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
        ext,
      });
    }
  };

  walk(resolvedRoot);
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return { files, tooLarge };
}

export function hashBuffer(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** `.eml` files: keep only From/Subject as context, then the body. */
function stripEmailHeaders(raw: string): string {
  const split = raw.search(/\r?\n\r?\n/);
  if (split === -1) return raw;

  const headerBlock = raw.slice(0, split);
  const body = raw.slice(split).replace(/^\r?\n\r?\n/, '');
  const keep = headerBlock
    .split(/\r?\n/)
    .filter((line) => /^(from|subject):/i.test(line));

  return [...keep, '', body].join('\n');
}

/**
 * Reads a file into the shape `extractPatientBatch` expects. `buf` is the
 * bytes already read for hashing, so the file is only touched once.
 */
export async function readForExtraction(file: SourceFile, buf: Buffer): Promise<BatchExtractionInput> {
  switch (file.ext) {
    case '.pdf':
      return { kind: 'pdf', base64: buf.toString('base64') };
    case '.docx':
      return { kind: 'text', text: docxToText(buf) };
    case '.xlsx':
      return { kind: 'text', text: await xlsxToText(buf) };
    case '.eml':
      return { kind: 'text', text: stripEmailHeaders(buf.toString('utf-8')) };
    case '.csv':
    case '.txt':
    default:
      return { kind: 'text', text: buf.toString('utf-8') };
  }
}
