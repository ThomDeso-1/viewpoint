import { v4 as uuid } from 'uuid';
import { getDb } from '../db/db.js';
import type { EligibilityCheckRow } from '../db/practice.js';
import { getHcvClient, hcvMode, HcvError, type EligibilityResult } from './ohip/index.js';
import { readHealthCard, getPatient } from './patients.js';
import { encryptOptional } from './crypto.js';
import { audit } from './audit.js';

/**
 * Runs OHIP eligibility checks and records the outcome.
 *
 * The health card number is decrypted here, held only for the duration of
 * the call, and never written back: the stored row keeps the result and
 * an encrypted copy of the ministry's response, but not the number.
 */

export interface EligibilityOutcome {
  checkId: string;
  isEligible: boolean | null;
  responseCode: string | null;
  responseDescription: string | null;
  mode: string;
  error: string | null;
  checkedAt: string;
}

function record(row: {
  patientId: string | null;
  appointmentId: string | null;
  dateOfService: string | null;
  result: EligibilityResult | null;
  error: string | null;
}): EligibilityOutcome {
  const id = uuid();
  const checkedAt = new Date().toISOString();
  const mode = row.result?.mode ?? hcvMode();

  getDb()
    .prepare(
      `INSERT INTO eligibility_checks (
         id, patient_id, appointment_id, checked_at, date_of_service,
         is_eligible, response_code, response_description, raw_response_enc,
         error, mode
       ) VALUES (
         @id, @patient_id, @appointment_id, @checked_at, @date_of_service,
         @is_eligible, @response_code, @response_description, @raw_response_enc,
         @error, @mode
       )`,
    )
    .run({
      id,
      patient_id: row.patientId,
      appointment_id: row.appointmentId,
      checked_at: checkedAt,
      date_of_service: row.dateOfService,
      is_eligible: row.result ? (row.result.isEligible ? 1 : 0) : null,
      response_code: row.result?.responseCode ?? null,
      response_description: row.result?.responseDescription ?? null,
      // The ministry response echoes patient identity, so it is stored
      // encrypted like every other piece of health information.
      raw_response_enc: encryptOptional(row.result?.raw ?? null),
      error: row.error,
      mode,
    });

  audit({
    action: 'eligibility.check',
    entityType: 'patient',
    entityId: row.patientId ?? undefined,
    detail: row.error ? `error: ${row.error}` : `${mode}: ${row.result?.responseCode ?? 'none'}`,
  });

  return {
    checkId: id,
    isEligible: row.result ? row.result.isEligible : null,
    responseCode: row.result?.responseCode ?? null,
    responseDescription: row.result?.responseDescription ?? null,
    mode,
    error: row.error,
    checkedAt,
  };
}

/**
 * Checks a patient's coverage and stores the result.
 *
 * A ministry rejection is a *result*, not a failure — it records normally.
 * Only transport or configuration problems produce an `error` outcome,
 * and those are the ones the queue will retry.
 */
export async function checkPatientEligibility(opts: {
  patientId: string;
  appointmentId?: string | null;
  dateOfService?: string;
}): Promise<EligibilityOutcome> {
  const patient = getPatient(opts.patientId);
  const dateOfService = opts.dateOfService ?? new Date().toISOString().slice(0, 10);

  if (!patient) {
    // patient_id is a foreign key, so it has to stay null here — the id
    // goes in the error text instead of breaking the insert.
    return record({
      patientId: null,
      appointmentId: opts.appointmentId ?? null,
      dateOfService,
      result: null,
      error: `Patient not found: ${opts.patientId}`,
    });
  }

  const healthCard = readHealthCard(opts.patientId, 'OHIP eligibility check');

  if (!healthCard) {
    return record({
      patientId: opts.patientId,
      appointmentId: opts.appointmentId ?? null,
      dateOfService,
      result: null,
      error: 'No health card number on file for this patient.',
    });
  }

  try {
    const result = await getHcvClient().checkEligibility({
      healthCardNumber: healthCard,
      versionCode: patient.health_card_version,
      dateOfService,
    });

    return record({
      patientId: opts.patientId,
      appointmentId: opts.appointmentId ?? null,
      dateOfService,
      result,
      error: null,
    });
  } catch (err) {
    const message = err instanceof HcvError ? err.message : (err as Error).message;

    return record({
      patientId: opts.patientId,
      appointmentId: opts.appointmentId ?? null,
      dateOfService,
      result: null,
      error: message,
    });
  }
}

/** True when the failure is worth another attempt later. */
export function isRetryableEligibilityError(err: unknown): boolean {
  return err instanceof HcvError && err.isRetryable;
}

export function latestCheckForPatient(patientId: string): EligibilityCheckRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM eligibility_checks WHERE patient_id = ? ORDER BY checked_at DESC, rowid DESC LIMIT 1`)
    .get(patientId) as EligibilityCheckRow | undefined;
}

export function latestCheckForAppointment(appointmentId: string): EligibilityCheckRow | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM eligibility_checks WHERE appointment_id = ? ORDER BY checked_at DESC, rowid DESC LIMIT 1`,
    )
    .get(appointmentId) as EligibilityCheckRow | undefined;
}

export function checksForPatient(patientId: string, limit = 20): EligibilityCheckRow[] {
  return getDb()
    .prepare(`SELECT * FROM eligibility_checks WHERE patient_id = ? ORDER BY checked_at DESC, rowid DESC LIMIT ?`)
    .all(patientId, limit) as EligibilityCheckRow[];
}

/** API shape — deliberately omits the encrypted raw response. */
export function toEligibilityDto(row: EligibilityCheckRow) {
  return {
    id: row.id,
    checked_at: row.checked_at,
    date_of_service: row.date_of_service,
    is_eligible: row.is_eligible === null ? null : row.is_eligible === 1,
    response_code: row.response_code,
    response_description: row.response_description,
    error: row.error,
    mode: row.mode,
  };
}
