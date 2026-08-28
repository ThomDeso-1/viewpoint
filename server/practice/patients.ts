import { v4 as uuid } from 'uuid';
import { getDb } from '../db/db.js';
import type { PatientRow } from './types.js';
import { encryptOptional, decryptOptional } from '../platform/crypto.js';
import { audit } from '../platform/audit.js';

/**
 * Patient records — the app's only store of personal health information.
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
}

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
}

// ── Reads ──

export function getPatient(id: string): PatientRow | undefined {
  return getDb().prepare(`SELECT * FROM patients WHERE id = ?`).get(id) as PatientRow | undefined;
}

export function listPatients(): PatientRow[] {
  return getDb()
    .prepare(`SELECT * FROM patients ORDER BY full_name COLLATE NOCASE ASC`)
    .all() as PatientRow[];
}

export function findPatientByEmail(email: string): PatientRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM patients WHERE email = ? COLLATE NOCASE`)
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
      .prepare(`SELECT * FROM patients WHERE full_name = ? COLLATE NOCASE`)
      .get(fullName) as PatientRow | undefined;
  }

  return undefined;
}

// ── Writes ──

export function createPatient(input: PatientInput): PatientRow {
  const now = new Date().toISOString();
  const id = uuid();

  getDb()
    .prepare(
      `INSERT INTO patients (
         id, full_name, email, phone, date_of_birth,
         health_card_enc, health_card_version, wave_customer_id, notes,
         created_at, updated_at
       ) VALUES (
         @id, @full_name, @email, @phone, @date_of_birth,
         @health_card_enc, @health_card_version, NULL, @notes,
         @created_at, @updated_at
       )`,
    )
    .run({
      id,
      full_name: input.full_name,
      email: input.email ?? null,
      phone: input.phone ?? null,
      date_of_birth: input.date_of_birth ?? null,
      health_card_enc: encryptOptional(input.health_card_number),
      health_card_version: input.health_card_version ?? null,
      notes: input.notes ?? null,
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

export function deletePatient(id: string): boolean {
  const result = getDb().prepare(`DELETE FROM patients WHERE id = ?`).run(id);
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
  };
}
