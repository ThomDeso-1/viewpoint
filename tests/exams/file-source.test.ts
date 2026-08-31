import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { makeXlsx } from '../helpers/makeXlsx.js';
import { makeDocx } from '../helpers/makeDocx.js';
import { docxToText } from '../../server/exams/docx.js';
import {
  walkSourceDir,
  hashBuffer,
  readForExtraction,
  SourceFolderError,
} from '../../server/exams/file-source.js';

/**
 * The filesystem half of the folder scanner: what counts as a file, the
 * content hash that decides whether one has been seen, and how each type
 * is read for extraction.
 */

describe('walkSourceDir', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-src-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const write = (rel: string, body = 'x') => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
    return full;
  };

  it('finds supported files recursively', () => {
    write('a.csv');
    write('sub/b.txt');
    write('sub/deep/c.eml');

    const { files } = walkSourceDir(dir);
    expect(files.map((f) => f.relativePath).sort()).toEqual([
      'a.csv',
      path.join('sub', 'b.txt'),
      path.join('sub', 'deep', 'c.eml'),
    ]);
  });

  it('ignores hidden files, Office lock files and unsupported extensions', () => {
    write('good.txt');
    write('.hidden.csv');
    write('~$open.xlsx');
    write('notes.rtf');
    write('image.png');

    const { files } = walkSourceDir(dir);
    expect(files.map((f) => f.relativePath)).toEqual(['good.txt']);
  });

  it('skips symlinks rather than following them out of the folder', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-out-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'link.txt'));

    const { files } = walkSourceDir(dir);
    expect(files).toHaveLength(0);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('drops files over the size cap', () => {
    process.env.EXAM_REQUEST_SOURCE_MAX_FILE_MB = '0.001'; // ~1KB
    write('small.txt', 'x'.repeat(100));
    write('big.txt', 'x'.repeat(5000));

    const { files, tooLarge } = walkSourceDir(dir);
    expect(files.map((f) => f.relativePath)).toEqual(['small.txt']);
    expect(tooLarge).toEqual(['big.txt']);
    delete process.env.EXAM_REQUEST_SOURCE_MAX_FILE_MB;
  });

  it('throws for a missing folder', () => {
    expect(() => walkSourceDir(path.join(dir, 'nope'))).toThrow(SourceFolderError);
  });

  it('throws when pointed at a file', () => {
    const file = write('a.txt');
    expect(() => walkSourceDir(file)).toThrow(SourceFolderError);
  });
});

describe('docxToText', () => {
  it('rejects a file that is not a Word document', () => {
    expect(() => docxToText(Buffer.from('not a zip'))).toThrow();
  });

  it('decodes entities and keeps row structure', () => {
    const buf = makeDocx([{ table: [['A & B', 'C < D'], ['1', '2']] }]);
    const text = docxToText(buf);
    expect(text).toContain('A & B\tC < D');
    expect(text).toContain('1\t2');
  });
});

describe('hashBuffer', () => {
  it('changes when the bytes change', () => {
    expect(hashBuffer(Buffer.from('one'))).not.toBe(hashBuffer(Buffer.from('two')));
    expect(hashBuffer(Buffer.from('same'))).toBe(hashBuffer(Buffer.from('same')));
  });
});

describe('readForExtraction', () => {
  const file = (ext: string) => ({
    relativePath: `f${ext}`,
    absolutePath: `/tmp/f${ext}`,
    size: 1,
    mtime: '2026-01-01T00:00:00.000Z',
    ext,
  });

  it('sends a PDF straight through as base64', async () => {
    const buf = Buffer.from('%PDF-1.4 fake');
    const input = await readForExtraction(file('.pdf'), buf);
    expect(input).toEqual({ kind: 'pdf', base64: buf.toString('base64') });
  });

  it('flattens a Word document to tab-separated tables', async () => {
    const buf = makeDocx([
      'August 27, 2026 — Clinic Schedule',
      { table: [['Time', 'Patient'], ['9:30', 'Peter Fatijewski']] },
    ]);
    const input = await readForExtraction(file('.docx'), buf);
    expect(input.kind).toBe('text');
    const text = (input as { text: string }).text;
    expect(text).toContain('August 27, 2026');
    expect(text).toContain('9:30\tPeter Fatijewski');
  });

  it('flattens a spreadsheet to text', async () => {
    const buf = makeXlsx([
      ['Name', 'DOB'],
      ['Ada Lovelace', '1990-01-01'],
    ]);
    const input = await readForExtraction(file('.xlsx'), buf);
    expect(input.kind).toBe('text');
    expect((input as { text: string }).text).toContain('Ada Lovelace');
  });

  it('passes CSV and plain text through unchanged', async () => {
    const input = await readForExtraction(file('.csv'), Buffer.from('name,dob\nAda,1990'));
    expect(input).toEqual({ kind: 'text', text: 'name,dob\nAda,1990' });
  });

  it('strips headers from a .eml, keeping From and Subject', async () => {
    const eml = 'From: ada@example.com\r\nTo: clinic@x.com\r\nSubject: Booking\r\n\r\nPlease book me.';
    const input = await readForExtraction(file('.eml'), Buffer.from(eml));
    const text = (input as { text: string }).text;
    expect(text).toContain('From: ada@example.com');
    expect(text).toContain('Subject: Booking');
    expect(text).not.toContain('To: clinic@x.com');
    expect(text).toContain('Please book me.');
  });
});
