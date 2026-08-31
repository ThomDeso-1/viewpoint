import { unzipSync, strFromU8 } from 'fflate';

/**
 * Flattens a Word `.docx` to plain text for extraction.
 *
 * A clinic schedule is a set of Word tables — one row per patient, plus a
 * separate "notes" table keyed by patient. The scanner feeds this text to
 * Claude, so the table structure has to survive: cells become tab-
 * separated, rows and paragraphs become newlines. Formatting is dropped.
 */

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&(amp|lt|gt|quot|apos|#39);/g, (m) => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

export function docxToText(buf: Buffer): string {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(buf));
  } catch (err) {
    throw new Error(`Could not open the Word document: ${(err as Error).message}`);
  }

  const doc = files['word/document.xml'];
  if (!doc) throw new Error('Not a Word document (no word/document.xml).');

  const xml = strFromU8(doc)
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<w:br\b[^>]*\/?>/g, '\n')
    // A table cell ends with `</w:p></w:tc>` — collapse the pair to one
    // tab so the paragraph break inside the last cell doesn't leak out.
    .replace(/<\/w:p>\s*<\/w:tc>/g, '\t')
    .replace(/<\/w:p>\s*<\/w:tr>/g, '\n')
    .replace(/<\/w:tc>/g, '\t')
    .replace(/<\/w:tr>/g, '\n')
    .replace(/<\/w:p>/g, '\n');

  return decodeEntities(xml.replace(/<[^>]+>/g, ''))
    .replace(/\n\t/g, '\t')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
