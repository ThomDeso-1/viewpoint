import { zipSync, strToU8 } from 'fflate';

/**
 * Builds a minimal `.docx` Buffer from tables of strings, for tests.
 *
 * Each `table` is rows of cell strings; a bare string is a plain
 * paragraph. Only what `docxToText` needs to read the structure back.
 */
type Block = string | { table: string[][] };

const esc = (v: string) =>
  v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function para(text: string): string {
  return `<w:p><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
}

function table(rows: string[][]): string {
  const trs = rows
    .map((cells) => {
      const tcs = cells.map((c) => `<w:tc>${para(c)}</w:tc>`).join('');
      return `<w:tr>${tcs}</w:tr>`;
    })
    .join('');
  return `<w:tbl>${trs}</w:tbl>`;
}

export function makeDocx(blocks: Block[]): Buffer {
  const body = blocks
    .map((b) => (typeof b === 'string' ? para(b) : table(b.table)))
    .join('');

  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${body}</w:body></w:document>`;

  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
        `</Types>`,
    ),
    '_rels/.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
        `</Relationships>`,
    ),
    'word/document.xml': strToU8(documentXml),
  };

  return Buffer.from(zipSync(files));
}
