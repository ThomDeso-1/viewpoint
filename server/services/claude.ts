import fs from 'fs';
import path from 'path';

/**
 * Claude API Service — server-side port of ClaudeAPIService.swift
 *
 * Sends receipt images to the Claude Messages API (vision) for structured
 * data extraction. Uses claude-sonnet-4 for extraction, claude-haiku-3.5
 * for validation.
 */

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const EXTRACTION_MODEL = 'claude-sonnet-4-20250514';
const VALIDATION_MODEL = 'claude-haiku-3-5-20241022';
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
    res = await fetch(ENDPOINT, {
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
