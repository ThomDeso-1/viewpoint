import readXlsxFile from 'read-excel-file/node';

/**
 * Flattens an `.xlsx` workbook to plain text for extraction.
 *
 * The folder scanner feeds this to Claude alongside PDFs and notes, so the
 * output only needs to be readable, not round-trippable: one block per
 * sheet, one line per row, cells tab-separated. Empty trailing cells and
 * fully-blank rows are dropped so a sparse sheet doesn't become a wall of
 * tabs.
 */

function cellToText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

export async function xlsxToText(input: string | Buffer): Promise<string> {
  const sheets = await readXlsxFile(input as Parameters<typeof readXlsxFile>[0]);

  const blocks: string[] = [];
  for (const { sheet, data } of sheets) {
    const lines: string[] = [];
    for (const row of data) {
      const cells = row.map(cellToText);
      while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
      if (cells.length === 0) continue;
      lines.push(cells.join('\t'));
    }
    if (lines.length === 0) continue;
    blocks.push(`# Sheet: ${sheet}\n${lines.join('\n')}`);
  }

  return blocks.join('\n\n');
}
