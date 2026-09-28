import { v4 as uuid } from 'uuid';
import { getDb } from '../db/db.js';
import type { PatientRow, FollowupMode, ClientType } from './types.js';
import { encryptOptional, decryptOptional } from '../platform/crypto.js';
import { audit } from '../platform/audit.js';

const FOLLOWUP_MODES: readonly FollowupMode[] = ['off', 'remind', 'followup'];
export const CLIENT_TYPES: readonly ClientType[] = ['patient', 'customer', 'business'];

function isClientType(value: unknown): value is ClientType {
  return CLIENT_TYPES.includes(value as ClientType);
}

/**
 * Client records — the app's only store of personal health information.
 *
 * Shown as "Clients" since migration 011: one directory for patients,
 * eyewear customers and businesses, told apart by `client_type`. The
 * table, this module and the API paths keep the `patient` name — see the
 * migration for why.
 *
 * Two rules this module exists to enforce, so no caller has to remember
 * them:
 *   1. Health card numbers are encrypted on the way in and decrypted only
 *      through readHealthCard(), which audits every access.
 *   2. Nothing leaves here as a plain row. toPatientDto() masks the card
 *      so an accidental `res.json(row)` can't leak it.
 */

export interface PatientInput {
  full_name: string;
  email?: string | null;
  phone?: string | null;
  date_of_birth?: string | null;
  health_card_number?: string | null;
  health_card_version?: string | null;
  notes?: string | null;
  followup_mode?: FollowupMode;
  followup_date_override?: string | null;
  client_type?: ClientType;
  address?: string | null;
  /** Only `null` is accepted — "Not a duplicate". Imports set it directly. */
  possible_duplicate_of?: null;
}

export type PatientUpdate = Partial<PatientInput>;

/** What the API returns: never the card number, only whether one is on file. */
export interface PatientDto {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  date_of_birth: string | null;
  has_health_card: boolean;
  /** e.g. "•••• ••6789" — enough to recognise a record, not to use one. */
  health_card_masked: string | null;
  health_card_version: string | null;
  wave_customer_id: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  followup_mode: FollowupMode;
  followup_date_override: string | null;
  followup_dismissed_at: string | null;
  followup_last_emailed_at: string | null;
  client_type: ClientType;
  address: string | null;
  possible_duplicate_of: string | null;
}

// ── Reads ──

// Every read filters out soft-deleted rows (migration 005). A deleted
// patient is invisible to matching, the API, and the queue — but their
// appointments, invoices and eligibility history stay resolvable.

export function getPatient(id: string): PatientRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM patients WHERE id = ? AND deleted_at IS NULL`)
    .get(id) as PatientRow | undefined;
}

export function listPatients(): PatientRow[] {
  return getDb()
    .prepare(`SELECT * FROM patients WHERE deleted_at IS NULL ORDER BY full_name COLLATE NOCASE ASC`)
    .all() as PatientRow[];
}

export function findPatientByEmail(email: string): PatientRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM patients WHERE email = ? COLLATE NOCASE AND deleted_at IS NULL`)
    .get(email) as PatientRow | undefined;
}

/**
 * Best-effort match for an incoming exam request.
 *
 * Email first because it's unique in practice; falls back to an exact
 * case-insensitive name match. Deliberately conservative — a wrong match
 * would attach one patient's appointment to another's record, so anything
 * fuzzier is left for the operator to confirm.
 */
export function findMatchingPatient(email?: string | null, fullName?: string | null): PatientRow | undefined {
  if (email) {
    const byEmail = findPatientByEmail(email);
    if (byEmail) return byEmail;
  }

  if (fullName) {
    return getDb()
      .prepare(`SELECT * FROM patients WHERE full_name = ? COLLATE NOCASE AND deleted_at IS NULL`)
      .get(fullName) as PatientRow | undefined;
  }

  return undefined;
}

export function findPatientByWaveCustomerId(waveCustomerId: string): PatientRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM patients WHERE wave_customer_id = ? AND deleted_at IS NULL`)
    .get(waveCustomerId) as PatientRow | undefined;
}

/** Every live client with this exact name (case-insensitive) — for duplicate flagging. */
export function findPatientsByName(fullName: string): PatientRow[] {
  return getDb()
    .prepare(`SELECT * FROM patients WHERE full_name = ? COLLATE NOCASE AND deleted_at IS NULL`)
    .all(fullName.trim()) as PatientRow[];
}

// ── Writes ──

const INSERT_PATIENT_SQL = `INSERT INTO patients (
     id, full_name, email, phone, date_of_birth,
     health_card_enc, health_card_version, wave_customer_id, notes,
     client_type, address, possible_duplicate_of,
     created_at, updated_at
   ) VALUES (
     @id, @full_name, @email, @phone, @date_of_birth,
     @health_card_enc, @health_card_version, @wave_customer_id, @notes,
     @client_type, @address, @possible_duplicate_of,
     @created_at, @updated_at
   )`;

export function createPatient(input: PatientInput): PatientRow {
  const now = new Date().toISOString();
  const id = uuid();

  getDb()
    .prepare(INSERT_PATIENT_SQL)
    .run({
      id,
      full_name: input.full_name,
      email: input.email ?? null,
      phone: input.phone ?? null,
      date_of_birth: input.date_of_birth ?? null,
      health_card_enc: encryptOptional(input.health_card_number),
      health_card_version: input.health_card_version ?? null,
      wave_customer_id: null,
      notes: input.notes ?? null,
      client_type: isClientType(input.client_type) ? input.client_type : 'patient',
      address: input.address ?? null,
      possible_duplicate_of: null,
      created_at: now,
      updated_at: now,
    });

  audit({ action: 'patient.create', entityType: 'patient', entityId: id });

  return getPatient(id)!;
}

export function updatePatient(id: string, input: Partial<PatientInput>): PatientRow | undefined {
  const existing = getPatient(id);
  if (!existing) return undefined;

  // Only overwrite the stored card when the caller actually supplied one —
  // an update that omits the field must not silently erase it.
  const healthCardEnc =
    input.health_card_number === undefined
      ? existing.health_card_enc
      : encryptOptional(input.health_card_number);

  const followupOverride =
    input.followup_date_override === undefined
      ? existing.followup_date_override
      : input.followup_date_override || null;

  // Moving the follow-up date by hand reopens it — a "Done" from the old
  // cycle shouldn't keep the new date hidden.
  const followupDismissedAt =
    followupOverride === existing.followup_date_override
      ? existing.followup_dismissed_at
      : null;

  getDb()
    .prepare(
      `UPDATE patients SET
         full_name = @full_name,
         email = @email,
         phone = @phone,
         date_of_birth = @date_of_birth,
         health_card_enc = @health_card_enc,
         health_card_version = @health_card_version,
         notes = @notes,
         followup_mode = @followup_mode,
         followup_date_override = @followup_date_override,
         followup_dismissed_at = @followup_dismissed_at,
         client_type = @client_type,
         address = @address,
         possible_duplicate_of = @possible_duplicate_of,
         updated_at = @updated_at
       WHERE id = @id`,
    )
    .run({
      id,
      full_name: input.full_name ?? existing.full_name,
      email: input.email === undefined ? existing.email : input.email,
      phone: input.phone === undefined ? existing.phone : input.phone,
      date_of_birth: input.date_of_birth === undefined ? existing.date_of_birth : input.date_of_birth,
      health_card_enc: healthCardEnc,
      health_card_version:
        input.health_card_version === undefined
          ? existing.health_card_version
          : input.health_card_version,
      notes: input.notes === undefined ? existing.notes : input.notes,
      followup_mode:
        input.followup_mode === undefined
          ? existing.followup_mode
          : FOLLOWUP_MODES.includes(input.followup_mode)
            ? input.followup_mode
            : existing.followup_mode,
      followup_date_override: followupOverride,
      followup_dismissed_at: followupDismissedAt,
      client_type: isClientType(input.client_type) ? input.client_type : existing.client_type,
      address: input.address === undefined ? existing.address : input.address || null,
      // Can only be cleared here ("Not a duplicate"); imports set it.
      possible_duplicate_of:
        input.possible_duplicate_of === null ? null : existing.possible_duplicate_of,
      updated_at: new Date().toISOString(),
    });

  audit({ action: 'patient.update', entityType: 'patient', entityId: id });

  return getPatient(id);
}

export function setWaveCustomerId(patientId: string, waveCustomerId: string): void {
  getDb()
    .prepare(`UPDATE patients SET wave_customer_id = ?, updated_at = ? WHERE id = ?`)
    .run(waveCustomerId, new Date().toISOString(), patientId);
}

// ── Wave customer import ──

/** Contact details an import may fill in — only where the record has none. */
export interface ImportedContact {
  email: string | null;
  phone: string | null;
  address: string | null;
  notes: string | null;
}

/** One write the Wave import will make, as decided at preview time. */
export type ClientImportOp =
  | {
      kind: 'create';
      waveCustomerId: string;
      full_name: string;
      client_type: ClientType;
      contact: ImportedContact;
      /** Name-only match the operator chose to keep separate. */
      possible_duplicate_of: string | null;
    }
  | { kind: 'link'; patientId: string; waveCustomerId: string; contact: ImportedContact }
  | { kind: 'fill'; patientId: string; contact: ImportedContact };

export interface ClientImportResult {
  created: number;
  linked: number;
  updated: number;
  flagged: number;
  skipped: number;
}

/**
 * Applies a reviewed Wave import in one transaction — all of it or none.
 *
 * Never overwrites: a link or fill only writes a field the record has
 * empty, and never touches name, date of birth or health card. Each op
 * re-checks the state it was planned against (the preview may be minutes
 * old), and one that no longer applies is counted as skipped rather than
 * forced. One summary audit row, not one per client — a first import can
 * be hundreds of rows.
 */
export function applyClientImport(ops: ClientImportOp[]): ClientImportResult {
  const db = getDb();
  const result: ClientImportResult = { created: 0, linked: 0, updated: 0, flagged: 0, skipped: 0 };
  const now = new Date().toISOString();

  const insert = db.prepare(INSERT_PATIENT_SQL);
  const fillGaps = db.prepare(
    `UPDATE patients SET
       email   = COALESCE(NULLIF(email, ''),   @email),
       phone   = COALESCE(NULLIF(phone, ''),   @phone),
       address = COALESCE(NULLIF(address, ''), @address),
       notes   = COALESCE(NULLIF(notes, ''),   @notes),
       updated_at = @now
     WHERE id = @id AND deleted_at IS NULL`,
  );
  const link = db.prepare(
    `UPDATE patients SET wave_customer_id = @wave_customer_id, updated_at = @now
     WHERE id = @id AND deleted_at IS NULL AND wave_customer_id IS NULL`,
  );

  db.transaction(() => {
    for (const op of ops) {
      if (op.kind === 'create') {
        // Already imported (a second apply, or linked since the preview).
        if (findPatientByWaveCustomerId(op.waveCustomerId)) {
          result.skipped++;
          continue;
        }
        insert.run({
          id: uuid(),
          full_name: op.full_name,
          email: op.contact.email,
          phone: op.contact.phone,
          date_of_birth: null,
          health_card_enc: null,
          health_card_version: null,
          wave_customer_id: op.waveCustomerId,
          notes: op.contact.notes,
          client_type: op.client_type,
          address: op.contact.address,
          possible_duplicate_of: op.possible_duplicate_of,
          created_at: now,
          updated_at: now,
        });
        result.created++;
        if (op.possible_duplicate_of) result.flagged++;
      } else if (op.kind === 'link') {
        if (findPatientByWaveCustomerId(op.waveCustomerId)) {
          result.skipped++;
          continue;
        }
        if (link.run({ id: op.patientId, wave_customer_id: op.waveCustomerId, now }).changes === 0) {
          result.skipped++;
          continue;
        }
        fillGaps.run({ id: op.patientId, now, ...op.contact });
        result.linked++;
      } else {
        const changes = fillGaps.run({ id: op.patientId, now, ...op.contact }).changes;
        if (changes > 0) result.updated++;
        else result.skipped++;
      }
    }

    // Counts only — no names or contact details in the audit trail.
    audit({
      action: 'client.import',
      entityType: 'patient',
      detail:
        `wave: ${result.created} created (${result.flagged} flagged), ` +
        `${result.linked} linked, ${result.updated} updated, ${result.skipped} skipped`,
    });
  })();

  return result;
}

/**
 * Partial write of just the recall fields — used by the follow-up service
 * for dismiss / snooze / "email sent", none of which touch the rest of the
 * record. `undefined` leaves a column alone.
 */
export function setFollowupState(
  patientId: string,
  fields: {
    followup_date_override?: string | null;
    followup_dismissed_at?: string | null;
    followup_last_emailed_at?: string | null;
  },
): void {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id: patientId, updated_at: new Date().toISOString() };

  for (const key of [
    'followup_date_override',
    'followup_dismissed_at',
    'followup_last_emailed_at',
  ] as const) {
    if (fields[key] !== undefined) {
      sets.push(`${key} = @${key}`);
      params[key] = fields[key];
    }
  }
  if (sets.length === 0) return;

  getDb()
    .prepare(`UPDATE patients SET ${sets.join(', ')}, updated_at = @updated_at WHERE id = @id`)
    .run(params);
}

/**
 * Soft delete — stamps `deleted_at` rather than removing the row, so the
 * appointments, invoices and eligibility checks that reference this
 * patient stay resolvable (PHIPA retention, AUDIT P1-4). All reads here
 * filter deleted rows out, so the patient is otherwise gone.
 */
export function deletePatient(id: string): boolean {
  const result = getDb()
    .prepare(`UPDATE patients SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`)
    .run(new Date().toISOString(), new Date().toISOString(), id);
  if (result.changes > 0) {
    audit({ action: 'patient.delete', entityType: 'patient', entityId: id });
  }
  return result.changes > 0;
}

// ── Health card access ──

/**
 * Decrypts a patient's health card number.
 *
 * The single doorway to this data, and it audits every use. Callers should
 * hold the result only as long as the operation needs it — an eligibility
 * check — and never write it back anywhere unencrypted.
 */
export function readHealthCard(patientId: string, reason: string): string | null {
  const patient = getPatient(patientId);
  if (!patient?.health_card_enc) return null;

  audit({
    action: 'health_card.decrypt',
    entityType: 'patient',
    entityId: patientId,
    detail: reason,
  });

  return decryptOptional(patient.health_card_enc);
}

function maskHealthCard(enc: string | null): string | null {
  if (!enc) return null;
  try {
    const plain = decryptOptional(enc);
    if (!plain) return null;
    // No audit entry: this reveals only the last four digits, and every
    // patient list render would otherwise flood the log.
    return `•••• ••${plain.slice(-4)}`;
  } catch {
    return '•••• ••••';
  }
}

// ── Serialisation ──

export function toPatientDto(row: PatientRow): PatientDto {
  return {
    id: row.id,
    full_name: row.full_name,
    email: row.email,
    phone: row.phone,
    date_of_birth: row.date_of_birth,
    has_health_card: !!row.health_card_enc,
    health_card_masked: maskHealthCard(row.health_card_enc),
    health_card_version: row.health_card_version,
    wave_customer_id: row.wave_customer_id,
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
    followup_mode: row.followup_mode,
    followup_date_override: row.followup_date_override,
    followup_dismissed_at: row.followup_dismissed_at,
    followup_last_emailed_at: row.followup_last_emailed_at,
    client_type: row.client_type,
    address: row.address,
    possible_duplicate_of: row.possible_duplicate_of,
  };
}
