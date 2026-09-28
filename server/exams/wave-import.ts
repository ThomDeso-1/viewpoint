import crypto from 'crypto';
import { getConfig, setConfig } from '../db/db.js';
import { getWaveToken, isWaveConfigured } from '../integrations/wave/auth.js';
import {
  fetchCustomerPage,
  listAllCustomers,
  WaveAPIError,
  type WaveCustomerRecord,
} from '../integrations/wave/index.js';
import * as patients from './patients.js';
import type { ClientImportOp, ClientImportResult, ImportedContact } from './patients.js';
import type { ClientType, PatientRow } from './types.js';

/**
 * One-time import of Wave's customer list into the client directory.
 *
 * Three steps, each one the operator's explicit action:
 *
 *   1. verify   — reads ONE customer with the exact query the import
 *                 uses. The field names were written from Wave's docs,
 *                 not generated from its schema (AGENTS.md §6), so a
 *                 mismatch shows up here as a GraphQL error naming the
 *                 field, before any bulk read. Passing is remembered.
 *   2. preview  — reads every customer and works out what would happen
 *                 ("42 new, 17 would link"). Writes nothing.
 *   3. apply    — writes the previewed plan, with the operator's choice
 *                 for each name-only match.
 *
 * Nothing goes *to* Wave: this only reads from it, so it sits outside the
 * approval gate the same way the settings screens' Wave lookups do.
 *
 * Matching, most certain first:
 *   - already linked (same `wave_customer_id`) → fill empty fields only
 *   - same email, record not yet linked        → link + fill empty fields
 *   - same name only                           → flagged; operator decides
 *   - otherwise                                → new client
 */

const VERIFIED_KEY = 'wave_customer_import_verified_at';
const LAST_IMPORT_KEY = 'wave_customer_import_last_at';

/** A preview is only good for this long before apply asks for a fresh one. */
const PREVIEW_TTL_MS = 30 * 60_000;

export type NameMatchDecision = 'separate' | 'link' | 'skip';

export interface WaveImportStatus {
  waveConfigured: boolean;
  verifiedAt: string | null;
  lastImportAt: string | null;
}

export interface VerifyResult {
  ok: boolean;
  error?: string;
  /** Wave's own count of customers, when it reports one. */
  totalCount?: number | null;
}

interface ClientRef {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  client_type: ClientType;
}

export interface WaveImportPreview {
  previewId: string;
  fetched: number;
  archived: number;
  counts: {
    new: number;
    link: number;
    update: number;
    unchanged: number;
    nameMatch: number;
  };
  newByType: Record<ClientType, number>;
  newClients: { waveId: string; name: string; email: string | null; client_type: ClientType }[];
  links: { waveId: string; waveName: string; email: string | null; client: ClientRef }[];
  nameMatches: {
    waveId: string;
    waveName: string;
    email: string | null;
    phone: string | null;
    client: ClientRef;
  }[];
}

interface StoredPreview {
  createdAt: number;
  /** Ops that need no decision. */
  ops: ClientImportOp[];
  /** Per name-only match: what each decision turns into. */
  nameMatchOps: Map<string, { separate: ClientImportOp; link: ClientImportOp }>;
}

// In memory on purpose: a preview is a few minutes' worth of state for a
// single operator, and holding it avoids a second bulk read of Wave on
// apply (whose result could differ from what was shown). Only the latest
// preview is kept.
let stored: { id: string; preview: StoredPreview } | null = null;

export class WaveImportError extends Error {
  constructor(
    public readonly code: 'not_configured' | 'not_verified' | 'preview_expired',
    message: string,
  ) {
    super(message);
    this.name = 'WaveImportError';
  }
}

export function importStatus(): WaveImportStatus {
  return {
    waveConfigured: isWaveConfigured() && !!process.env.WAVE_BUSINESS_ID,
    // `||`, not `??`: a failed verify stores '' to clear the flag.
    verifiedAt: getConfig(VERIFIED_KEY) || null,
    lastImportAt: getConfig(LAST_IMPORT_KEY) || null,
  };
}

function requireBusiness(): string {
  const businessId = process.env.WAVE_BUSINESS_ID;
  if (!isWaveConfigured() || !businessId) {
    throw new WaveImportError('not_configured', 'Connect Wave and choose a business in Settings first.');
  }
  return businessId;
}

/** Step 1 — one customer, the full field set. */
export async function verifyWaveImport(): Promise<VerifyResult> {
  const businessId = requireBusiness();

  try {
    const page = await fetchCustomerPage(businessId, 1, 1, await getWaveToken());
    setConfig(VERIFIED_KEY, new Date().toISOString());
    return { ok: true, totalCount: page.totalCount };
  } catch (err) {
    if (!(err instanceof WaveAPIError)) throw err;
    // A later failure un-verifies, so the import button can't be pressed
    // against a query Wave now rejects.
    setConfig(VERIFIED_KEY, '');
    return { ok: false, error: err.message };
  }
}

// A company rather than a person. Deliberately narrow — a miss just means
// the operator reclassifies a row; a false hit on a person's name would be
// more confusing.
const BUSINESS_NAME =
  /\b(inc|incorporated|ltd|limited|llc|llp|corp|corporation|company|co\.|insurance|assurance|laborator(y|ies)|labs?|holdings|group|services)\b/i;

function guessClientType(c: WaveCustomerRecord): ClientType {
  if (!c.firstName && !c.lastName && BUSINESS_NAME.test(c.name)) return 'business';
  return 'customer';
}

function displayName(c: WaveCustomerRecord): string {
  return c.name || [c.firstName, c.lastName].filter(Boolean).join(' ');
}

function contactFrom(c: WaveCustomerRecord): ImportedContact {
  return {
    email: c.email,
    phone: c.phone ?? c.mobile,
    address: c.address,
    notes: c.internalNotes,
  };
}

/** Whether filling `row`'s empty fields from `contact` would change anything. */
function hasGaps(row: PatientRow, contact: ImportedContact): boolean {
  return (
    (!row.email && !!contact.email) ||
    (!row.phone && !!contact.phone) ||
    (!row.address && !!contact.address) ||
    (!row.notes && !!contact.notes)
  );
}

function ref(row: PatientRow): ClientRef {
  return {
    id: row.id,
    full_name: row.full_name,
    email: row.email,
    phone: row.phone,
    client_type: row.client_type,
  };
}

/** Step 2 — read everything, plan, write nothing. */
export async function previewWaveImport(): Promise<WaveImportPreview> {
  const businessId = requireBusiness();
  if (!importStatus().verifiedAt) {
    throw new WaveImportError('not_verified', 'Run "Verify import" first.');
  }

  const customers = await listAllCustomers(businessId, await getWaveToken());

  const preview: WaveImportPreview = {
    previewId: crypto.randomUUID(),
    fetched: customers.length,
    archived: 0,
    counts: { new: 0, link: 0, update: 0, unchanged: 0, nameMatch: 0 },
    newByType: { patient: 0, customer: 0, business: 0 },
    newClients: [],
    links: [],
    nameMatches: [],
  };
  const storedPreview: StoredPreview = { createdAt: Date.now(), ops: [], nameMatchOps: new Map() };

  // A client can be claimed by only one Wave customer per import — two
  // Wave records sharing an email must not both link to the same row.
  const claimed = new Set<string>();

  for (const c of customers) {
    if (c.isArchived) {
      preview.archived++;
      continue;
    }

    const name = displayName(c);
    if (!name) continue; // Wave requires a name; nothing sensible to import without one.
    const contact = contactFrom(c);

    const linked = patients.findPatientByWaveCustomerId(c.id);
    if (linked) {
      claimed.add(linked.id);
      if (hasGaps(linked, contact)) {
        preview.counts.update++;
        storedPreview.ops.push({ kind: 'fill', patientId: linked.id, contact });
      } else {
        preview.counts.unchanged++;
      }
      continue;
    }

    const byEmail = c.email ? patients.findPatientByEmail(c.email) : undefined;
    if (byEmail && !byEmail.wave_customer_id && !claimed.has(byEmail.id)) {
      claimed.add(byEmail.id);
      preview.counts.link++;
      preview.links.push({ waveId: c.id, waveName: name, email: c.email, client: ref(byEmail) });
      storedPreview.ops.push({ kind: 'link', patientId: byEmail.id, waveCustomerId: c.id, contact });
      continue;
    }

    const client_type = guessClientType(c);
    const create = (possible_duplicate_of: string | null): ClientImportOp => ({
      kind: 'create',
      waveCustomerId: c.id,
      full_name: name,
      client_type,
      contact,
      possible_duplicate_of,
    });

    // Name only: never auto-linked (two people can share a name). An
    // email match against an already-linked record lands here too — it's
    // a second Wave record for someone, which the operator should see.
    const sameName =
      byEmail ?? patients.findPatientsByName(name).find((row) => !claimed.has(row.id));
    if (sameName) {
      preview.counts.nameMatch++;
      preview.nameMatches.push({
        waveId: c.id,
        waveName: name,
        email: c.email,
        phone: contact.phone,
        client: ref(sameName),
      });
      storedPreview.nameMatchOps.set(c.id, {
        separate: create(sameName.id),
        link: sameName.wave_customer_id
          ? create(sameName.id) // can't link twice — "link" degrades to flagged
          : { kind: 'link', patientId: sameName.id, waveCustomerId: c.id, contact },
      });
      continue;
    }

    preview.counts.new++;
    preview.newByType[client_type]++;
    preview.newClients.push({ waveId: c.id, name, email: c.email, client_type });
    storedPreview.ops.push(create(null));
  }

  stored = { id: preview.previewId, preview: storedPreview };
  return preview;
}

/**
 * Step 3 — write the previewed plan.
 *
 * `decisions` maps a name-match's Wave id to what the operator chose; an
 * undecided one defaults to `separate` (imported, flagged as a possible
 * duplicate) so nothing is silently dropped or wrongly merged.
 */
export function applyWaveImport(
  previewId: string,
  decisions: Record<string, NameMatchDecision> = {},
): ClientImportResult {
  if (!stored || stored.id !== previewId || Date.now() - stored.preview.createdAt > PREVIEW_TTL_MS) {
    throw new WaveImportError('preview_expired', 'This preview has expired. Run the import again.');
  }

  const { ops, nameMatchOps } = stored.preview;
  const all = [...ops];
  let declined = 0;

  for (const [waveId, choices] of nameMatchOps) {
    const decision = decisions[waveId] ?? 'separate';
    if (decision === 'skip') declined++;
    else all.push(decision === 'link' ? choices.link : choices.separate);
  }

  const result = patients.applyClientImport(all);
  result.skipped += declined;

  stored = null;
  setConfig(LAST_IMPORT_KEY, new Date().toISOString());
  return result;
}

/** Test hook — drops the in-memory preview. */
export function _resetWaveImport(): void {
  stored = null;
}
