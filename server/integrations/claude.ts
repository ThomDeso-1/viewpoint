import fs from 'fs';
import path from 'path';
import type { ExamRequestExtraction } from '../exams/types.js';
import { endpoint } from '../platform/endpoints.js';

/**
 * Claude API Service — server-side port of ClaudeAPIService.swift
 *
 * Sends receipt images to the Claude Messages API (vision) for structured
 * data extraction, and parses incoming exam-request emails into structured
 * patient details. Uses Sonnet for extraction, Haiku for the cheap
 * API-key validation ping.
 */

// Bare model IDs (no date suffix) — the documented form for the 4.5 / 5
// families. Called with plain fetch, deliberately, matching wave.ts /
// microsoft/*.ts (see AGENTS.md §6).
const EXTRACTION_MODEL = 'claude-sonnet-5';
const VALIDATION_MODEL = 'claude-haiku-4-5';
const API_VERSION = '2023-06-01';

// ── Types ──

export interface LineItem {
  description: string;
  amount: number;
}

export interface TaxEntry {
  type: string; // "HST", "GST", "PST"
  rate: number; // 0.13
  amount: number;
}

export interface ExtractionResult {
  receipt_date: string; // "YYYY-MM-DD"
  vendor: string;
  items: LineItem[];
  summary_description: string;
  subtotal: number;
  taxes: TaxEntry[];
  total: number;
  currency: string; // "CAD"
  confidence: string; // "high" | "medium" | "low"
}

export class ClaudeAPIError extends Error {
  code: string;
  retryAfter?: number;

  constructor(code: string, message: string, retryAfter?: number) {
    super(message);
    this.name = 'ClaudeAPIError';
    this.code = code;
    this.retryAfter = retryAfter;
  }

  get isRetryable(): boolean {
    return this.code === 'rate_limited' || this.code === 'server_error' || this.code === 'network_error';
  }
}

// ── API Key Validation ──

export async function validateApiKey(apiKey: string): Promise<void> {
  await sendRequest(
    {
      model: VALIDATION_MODEL,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Say OK.' }],
    },
    apiKey,
  );
}

// ── Receipt Extraction ──

/**
 * Extract structured receipt data from image file(s).
 * Returns the parsed result plus the raw JSON string for sidecar storage.
 */
export async function extractReceipt(
  imagePaths: string[],
  apiKey: string,
): Promise<{ result: ExtractionResult; rawJSON: string }> {
  // Build content array: images first, then the extraction prompt
  const contentParts: any[] = [];

  for (const imgPath of imagePaths) {
    const buffer = fs.readFileSync(imgPath);
    const base64 = buffer.toString('base64');
    const ext = path.extname(imgPath).toLowerCase();
    const mediaType =
      ext === '.png'
        ? 'image/png'
        : ext === '.webp'
          ? 'image/webp'
          : ext === '.gif'
            ? 'image/gif'
            : 'image/jpeg';

    contentParts.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: mediaType,
        data: base64,
      },
    });
  }

  contentParts.push({
    type: 'text',
    text: EXTRACTION_PROMPT,
  });

  const responseText = await sendRequest(
    {
      model: EXTRACTION_MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: contentParts }],
    },
    apiKey,
  );

  // Strip markdown code fences if present
  const jsonString = stripCodeFences(responseText);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch (err) {
    throw new ClaudeAPIError(
      'extraction_failed',
      `Failed to parse extraction JSON: ${(err as Error).message}`,
    );
  }

  try {
    validateExtractionResult(parsed);
  } catch (err) {
    throw new ClaudeAPIError(
      'extraction_failed',
      `Claude returned an unexpected extraction format: ${(err as Error).message}`,
    );
  }

  return { result: parsed, rawJSON: jsonString };
}

/**
 * Guards the rest of the app (route handlers, DB writes) from a
 * malformed or reshaped extraction response — without this, a missing
 * `taxes` array would throw deep inside the route's `.reduce()` call,
 * and a missing `receipt_date` would silently write "undefinedT00:00…"
 * into the receipt_date column.
 */
function validateExtractionResult(value: unknown): asserts value is ExtractionResult {
  if (!value || typeof value !== 'object') {
    throw new Error('response is not a JSON object');
  }
  const v = value as Record<string, unknown>;

  if (typeof v.receipt_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v.receipt_date)) {
    throw new Error('"receipt_date" must be a "YYYY-MM-DD" string');
  }
  if (typeof v.vendor !== 'string') {
    throw new Error('"vendor" must be a string');
  }
  if (typeof v.summary_description !== 'string') {
    throw new Error('"summary_description" must be a string');
  }
  if (typeof v.subtotal !== 'number') {
    throw new Error('"subtotal" must be a number');
  }
  if (typeof v.total !== 'number') {
    throw new Error('"total" must be a number');
  }
  if (typeof v.currency !== 'string') {
    throw new Error('"currency" must be a string');
  }
  if (!Array.isArray(v.items)) {
    throw new Error('"items" must be an array');
  }
  if (!Array.isArray(v.taxes) || v.taxes.some((t) => typeof (t as any)?.amount !== 'number')) {
    throw new Error('"taxes" must be an array of entries with a numeric "amount"');
  }
}

// ── Network ──

async function sendRequest(body: Record<string, any>, apiKey: string): Promise<string> {
  let res: Response;

  try {
    res = await fetch(endpoint('anthropicMessages'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
  } catch (err) {
    throw new ClaudeAPIError('network_error', `Network error: ${(err as Error).message}`);
  }

  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({}));
    const errorMsg =
      (errorBody as any)?.error?.message || `HTTP ${res.status}`;

    switch (res.status) {
      case 401:
        throw new ClaudeAPIError('invalid_api_key', 'Your Claude API key is invalid or expired.');
      case 400: {
        const msg = errorMsg.toLowerCase();
        if (msg.includes('credit') || msg.includes('billing')) {
          throw new ClaudeAPIError(
            'insufficient_credit',
            "Your Claude account needs a top-up — there's no credit remaining.",
          );
        }
        throw new ClaudeAPIError('bad_request', errorMsg);
      }
      case 429: {
        const retryAfter = res.headers.get('retry-after');
        throw new ClaudeAPIError(
          'rate_limited',
          'Claude API rate limit reached. Please try again in a moment.',
          retryAfter ? parseInt(retryAfter, 10) : undefined,
        );
      }
      default:
        if (res.status >= 500) {
          throw new ClaudeAPIError('server_error', `Claude API error (${res.status}): ${errorMsg}`);
        }
        throw new ClaudeAPIError('unknown', errorMsg);
    }
  }

  const json = (await res.json()) as any;
  const text = json?.content?.[0]?.text;
  if (!text) {
    throw new ClaudeAPIError('invalid_response', 'Claude returned an unexpected response format.');
  }

  return text;
}

// ── Helpers ──

function stripCodeFences(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    const newlineIdx = cleaned.indexOf('\n');
    if (newlineIdx !== -1) {
      cleaned = cleaned.slice(newlineIdx + 1);
    }
  }
  if (cleaned.endsWith('```')) {
    cleaned = cleaned.slice(0, -3);
  }
  return cleaned.trim();
}

// ── Prompt ──

const EXTRACTION_PROMPT = `You are a receipt data extraction assistant. Analyze this receipt image \
and extract the structured data below. Return ONLY valid JSON with no \
additional text or explanation.

This is a Canadian business receipt. Look for HST, GST, and/or PST \
tax breakdowns. If only a single tax line is shown, report it as HST \
unless the label says otherwise.

Return this exact JSON structure:
{
  "receipt_date": "YYYY-MM-DD",
  "vendor": "Store or business name",
  "items": [
    {"description": "Item name or description", "amount": 0.00}
  ],
  "summary_description": "Brief summary of what was purchased",
  "subtotal": 0.00,
  "taxes": [
    {"type": "HST", "rate": 0.13, "amount": 0.00}
  ],
  "total": 0.00,
  "currency": "CAD",
  "confidence": "high"
}

Rules:
- receipt_date: the date printed on the receipt in YYYY-MM-DD format. \
If unreadable, use today's date.
- vendor: the business name at the top of the receipt.
- items: list each line item. If items are unclear, use a single entry \
with the summary.
- subtotal: the pre-tax subtotal. If not shown, compute from total - taxes.
- taxes: break down each tax line (HST, GST, PST). Include the rate as \
a decimal (e.g. 0.13 for 13%).
- total: the final amount paid.
- currency: default to "CAD" unless the receipt shows otherwise.
- confidence: "high" if all fields are clearly legible, "medium" if some \
are uncertain, "low" if the image is hard to read.`;

// ── Patient batch extraction ──

/** A file handed to the folder scanner: flattened text, or a PDF to read directly. */
export type BatchExtractionInput =
  | { kind: 'text'; text: string }
  | { kind: 'pdf'; base64: string };

/**
 * Reads a patient/appointment file into a list of structured requests.
 *
 * One file routinely lists many people (a spreadsheet export, a printed
 * day sheet), so this returns an array — one entry per patient. Every
 * field stays nullable for the same reason the email path kept them
 * nullable: a source that omits a health card or a time is normal, and
 * the queue surfaces the gap rather than inventing a value.
 */
export async function extractPatientBatch(
  input: BatchExtractionInput,
  apiKey: string,
): Promise<{ results: ExamRequestExtraction[]; rawJSON: string }> {
  if (input.kind === 'text' && !input.text.trim()) {
    return { results: [], rawJSON: '[]' };
  }

  const content: any[] =
    input.kind === 'pdf'
      ? [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: input.base64 },
          },
          { type: 'text', text: PATIENT_BATCH_PROMPT },
        ]
      : [{ type: 'text', text: `${PATIENT_BATCH_PROMPT}\n\n---\n\n${input.text}` }];

  const responseText = await sendRequest(
    { model: EXTRACTION_MODEL, max_tokens: 8192, messages: [{ role: 'user', content }] },
    apiKey,
  );

  const jsonString = stripCodeFences(responseText);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonString);
  } catch (err) {
    throw new ClaudeAPIError(
      'extraction_failed',
      `Failed to parse patient batch JSON: ${(err as Error).message}`,
    );
  }

  if (!Array.isArray(parsed)) {
    throw new ClaudeAPIError(
      'extraction_failed',
      'Claude returned a patient batch that was not a JSON array.',
    );
  }

  try {
    for (const item of parsed) validateExamRequestExtraction(item);
  } catch (err) {
    throw new ClaudeAPIError(
      'extraction_failed',
      `Claude returned an unexpected patient format: ${(err as Error).message}`,
    );
  }

  return { results: parsed as ExamRequestExtraction[], rawJSON: jsonString };
}

/**
 * Same role as validateExtractionResult above: stop a reshaped response
 * from reaching the database. Normalises absent/empty fields to null so
 * callers only ever test for null, not for null-or-""-or-undefined.
 */
function validateExamRequestExtraction(value: unknown): asserts value is ExamRequestExtraction {
  if (!value || typeof value !== 'object') {
    throw new Error('response is not a JSON object');
  }
  const v = value as Record<string, unknown>;

  const stringFields = [
    'patient_name',
    'email',
    'phone',
    'date_of_birth',
    'health_card_number',
    'health_card_version',
    'requested_date',
    'requested_time',
    'reason',
    'coverage_status',
    'notes',
  ] as const;

  for (const field of stringFields) {
    const raw = v[field];
    if (raw === undefined || raw === null || raw === '') {
      v[field] = null;
      continue;
    }
    if (typeof raw !== 'string') {
      throw new Error(`"${field}" must be a string or null`);
    }
    v[field] = raw.trim() || null;
  }

  if (v.requested_date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(v.requested_date as string)) {
    throw new Error('"requested_date" must be a "YYYY-MM-DD" string or null');
  }

  if (typeof v.confidence !== 'number' || Number.isNaN(v.confidence)) {
    throw new Error('"confidence" must be a number');
  }
  // Clamp rather than reject: a slightly out-of-range confidence is not
  // worth failing an otherwise good extraction over.
  v.confidence = Math.max(0, Math.min(1, v.confidence));

  if (v.health_card_number !== null) {
    // Ontario health card numbers are 10 digits; strip the spaces and
    // dashes people write them with so downstream comparison is stable.
    v.health_card_number = (v.health_card_number as string).replace(/[\s-]/g, '');
  }

  if (v.health_card_version !== null) {
    v.health_card_version = (v.health_card_version as string).toUpperCase().replace(/[\s-]/g, '');
  }
}

const PATIENT_BATCH_PROMPT = `You are helping an Ontario optician business (it fits and dispenses eyewear, and books eye exams with partner optometrists) process a clinic schedule file.

The document below is a Word or spreadsheet export, a printed appointment sheet, or free-form notes. It usually has ONE OR MORE schedule tables (one row per patient) AND separate "Notes" / "Messages" sections that refer back to individual patients by name and room/wing. It may describe ONE patient or MANY.

Extract every patient who has a booked appointment in a schedule table.

Return ONLY a JSON array. Each element is one patient, an object with exactly these keys:
{
  "patient_name": "the patient's name only, with trailing markers like * or 'NA' removed, or null",
  "email": "patient's (or their POA's) email address, or null",
  "phone": "patient's phone number, or null",
  "date_of_birth": "YYYY-MM-DD, or null",
  "health_card_number": "10-digit Ontario health card number, digits only, or null",
  "health_card_version": "2-letter version code, or null",
  "requested_date": "YYYY-MM-DD of the appointment, or null",
  "requested_time": "HH:MM in 24-hour time, or null",
  "reason": "brief clinical reason for the visit, or null",
  "coverage_status": "verbatim text of the row's Status / OHIP status / eligibility column for this patient (e.g. 'Ok', 'Not eligible', '$180 private pay', 'Elig. 12/05/24'), or null",
  "notes": "everything else worth showing the operator (see below), or null",
  "confidence": 0.0
}

Rules:
- Return [] if the document lists no booked patients.
- One element per booked patient (a schedule row with a time). SKIP wait
  lists, recall lists, and anyone marked declined or cancelled.
- **Merge the notes.** For each patient, combine their schedule row with
  any note, message, or comment elsewhere in the file that names them (or
  their room/wing). Put the combined free text in "notes" — include: fee
  or private-pay flags ("$140", "private pay $180"), attendance markers
  (A = attending, NA / N.A = not attending), contact caveats ("wrong
  phone #", "no email"), clinical context, and the POA name if given.
- **Notes can correct the row.** If a note says a value in the row is
  wrong (e.g. "DOB reads July 25 2026, a year error — confirm"), do NOT
  guess the corrected value: leave that field null and state the problem
  in "notes".
- **Capture the "Status" / "OHIP status" / eligibility column verbatim** into
  "coverage_status" (values like "Ok", "407", "$140", "Elig. 12/05/24"). Copy
  it as written — do not normalise or interpret it. You may also mention a
  fee/private-pay signal from it in "notes".
- Use null for anything the document does not state. Never invent or infer
  a value that is not there — a missing field is expected and fine.
- Column headers, labels and layout vary; map them by meaning, not exact
  name. The appointment date is often in a header line above the table.
- "confidence" is your 0.0–1.0 confidence that this is genuinely a booked
  eye-exam patient and that you read its details correctly. Use a low
  value for a header/total row or unclear key details.
- Return the raw JSON array only. No explanation, no markdown fences.`;
