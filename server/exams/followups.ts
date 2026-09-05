/**
 * Patient recall — "is this patient due back for an eye exam?"
 *
 * The app mirrors appointments from Outlook but stores no recall state.
 * This module derives, per patient:
 *   - the last appointment (most recent one already had)
 *   - the current appointment (next one booked, not yet had)
 *   - the follow-up appointment: the booked one if there is one, else the
 *     operator's override date, else last-exam-plus-interval
 * and decides which patients belong on the "Follow-ups due" list.
 *
 * The per-patient columns (`followup_mode`, `followup_date_override`,
 * `followup_dismissed_at`, `followup_last_emailed_at`) live on `patients`
 * (migration 009); everything else here is computed at read time.
 *
 * Recall cadence follows Ontario's OHIP-funded routine: every 12 months
 * for patients under 20 or 65+, every 24 months otherwise (24 when the
 * date of birth is unknown).
 */

import type { PatientRow, FollowupMode } from './types.js';
import * as patients from './patients.js';
import * as appointments from './appointments.js';
import { renderEmailTemplate } from './email-templates.js';

export const RECALL_SHORT_MONTHS = 12;
export const RECALL_STANDARD_MONTHS = 24;
export const MINOR_AGE = 20;
export const SENIOR_AGE = 65;

/**
 * A follow-up shows as "due" from `DUE_LEAD_DAYS` before its date until
 * `DUE_MAX_OVERDUE_DAYS` after it — past that an un-booked patient is a
 * lapsed record, not an actionable reminder, and drops off the list.
 */
export const DUE_LEAD_DAYS = 45;
export const DUE_MAX_OVERDUE_DAYS = 365;

const DAY_MS = 24 * 60 * 60 * 1000;

export type FollowupSource = 'booked' | 'override' | 'computed';

export interface ResolvedFollowup {
  /** ISO instant. Booked → the appointment start; override/computed → that day at 00:00 UTC. */
  date: string;
  source: FollowupSource;
  appointmentId?: string;
}

export interface FollowupSummary {
  last_appointment_at: string | null;
  current_appointment_at: string | null;
  /** 'YYYY-MM-DD', or null when there's no history and no override. */
  followup_date: string | null;
  followup_source: FollowupSource | null;
  due: boolean;
  last_emailed_at: string | null;
}

// ── Date helpers (plain Date — no date library in the repo) ──

/** Adds `months`, clamping a rolled-over day back to the last of the target month. */
export function addMonths(iso: string, months: number): string {
  const d = new Date(iso);
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  if (d.getUTCDate() < day) d.setUTCDate(0);
  return d.toISOString();
}

function ageAt(dobIso: string, atIso: string): number {
  const dob = new Date(dobIso);
  const at = new Date(atIso);
  let age = at.getUTCFullYear() - dob.getUTCFullYear();
  const monthDelta = at.getUTCMonth() - dob.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && at.getUTCDate() < dob.getUTCDate())) age--;
  return age;
}

/** A bare 'YYYY-MM-DD' → that day at midnight UTC; anything else passed through. */
function toInstant(date: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00.000Z` : new Date(date).toISOString();
}

// ── Core logic ──

export function recallIntervalMonths(dobIso: string | null, referenceIso: string): number {
  if (!dobIso) return RECALL_STANDARD_MONTHS;
  const age = ageAt(dobIso, referenceIso);
  return age < MINOR_AGE || age >= SENIOR_AGE ? RECALL_SHORT_MONTHS : RECALL_STANDARD_MONTHS;
}

export function resolveFollowup(opts: {
  patient: Pick<PatientRow, 'date_of_birth' | 'followup_date_override'>;
  lastAppointmentAt: string | null;
  currentAppointmentAt: string | null;
  currentAppointmentId?: string | null;
}): ResolvedFollowup | null {
  if (opts.currentAppointmentAt) {
    return {
      date: opts.currentAppointmentAt,
      source: 'booked',
      appointmentId: opts.currentAppointmentId ?? undefined,
    };
  }
  if (opts.patient.followup_date_override) {
    return { date: toInstant(opts.patient.followup_date_override), source: 'override' };
  }
  if (opts.lastAppointmentAt) {
    const months = recallIntervalMonths(opts.patient.date_of_birth, opts.lastAppointmentAt);
    return { date: addMonths(opts.lastAppointmentAt, months), source: 'computed' };
  }
  return null;
}

export function isFollowupDue(opts: {
  patient: Pick<PatientRow, 'followup_mode' | 'followup_dismissed_at'>;
  resolved: ResolvedFollowup | null;
  lastAppointmentAt: string | null;
  now?: Date;
}): boolean {
  const { patient, resolved, lastAppointmentAt } = opts;
  if (!resolved || resolved.source === 'booked') return false;
  if (patient.followup_mode === 'off') return false;

  const now = (opts.now ?? new Date()).getTime();
  const due = new Date(resolved.date).getTime();
  if (due > now + DUE_LEAD_DAYS * DAY_MS) return false;
  if (due < now - DUE_MAX_OVERDUE_DAYS * DAY_MS) return false;

  // "Done" holds until a newer exam starts the next recall cycle. A dismiss
  // with no exam behind it (shouldn't happen — `resolved` would be null)
  // counts as handled.
  if (patient.followup_dismissed_at) {
    if (!lastAppointmentAt) return false;
    if (patient.followup_dismissed_at >= lastAppointmentAt) return false;
  }

  return true;
}

// ── Summaries ──

export function summariseFollowup(
  patient: PatientRow,
  lastAppointmentAt: string | null,
  currentAppointmentAt: string | null,
  currentAppointmentId: string | null,
  now: Date = new Date(),
): FollowupSummary {
  const resolved = resolveFollowup({
    patient,
    lastAppointmentAt,
    currentAppointmentAt,
    currentAppointmentId,
  });
  return {
    last_appointment_at: lastAppointmentAt,
    current_appointment_at: currentAppointmentAt,
    followup_date: resolved ? resolved.date.slice(0, 10) : null,
    followup_source: resolved ? resolved.source : null,
    due: isFollowupDue({ patient, resolved, lastAppointmentAt, now }),
    last_emailed_at: patient.followup_last_emailed_at,
  };
}

/** The follow-up summary for one patient (two single-row appointment lookups). */
export function followupForPatient(patientId: string, now: Date = new Date()): FollowupSummary | null {
  const patient = patients.getPatient(patientId);
  if (!patient) return null;

  const boundary = now.toISOString();
  const last = appointments.lastAppointmentFor(patientId, boundary);
  const current = appointments.currentAppointmentFor(patientId, boundary);
  return summariseFollowup(
    patient,
    last?.starts_at ?? null,
    current?.starts_at ?? null,
    current?.id ?? null,
    now,
  );
}

export interface DueFollowup {
  patient_id: string;
  full_name: string;
  email: string | null;
  mode: FollowupMode;
  last_appointment_at: string | null;
  followup_date: string;
  followup_last_emailed_at: string | null;
}

/** Every patient whose follow-up is due now — for the "Follow-ups due" list. */
export function listDueFollowups(now: Date = new Date()): DueFollowup[] {
  const boundary = now.toISOString();
  const lastMap = appointments.lastAppointmentByPatient(boundary);
  const currentMap = appointments.currentAppointmentByPatient(boundary);

  const out: DueFollowup[] = [];
  for (const patient of patients.listPatients()) {
    if (patient.followup_mode === 'off') continue;

    const lastAt = lastMap.get(patient.id) ?? null;
    const currentAt = currentMap.get(patient.id) ?? null;
    const resolved = resolveFollowup({
      patient,
      lastAppointmentAt: lastAt,
      currentAppointmentAt: currentAt,
    });
    if (!isFollowupDue({ patient, resolved, lastAppointmentAt: lastAt, now })) continue;

    out.push({
      patient_id: patient.id,
      full_name: patient.full_name,
      email: patient.email,
      mode: patient.followup_mode,
      last_appointment_at: lastAt,
      followup_date: resolved!.date.slice(0, 10),
      followup_last_emailed_at: patient.followup_last_emailed_at,
    });
  }

  out.sort((a, b) => a.followup_date.localeCompare(b.followup_date));
  return out;
}

// ── Mutations ──

/** "Done" — acknowledge the current cycle until a newer exam resets it. */
export function dismissFollowup(patientId: string): void {
  patients.setFollowupState(patientId, { followup_dismissed_at: new Date().toISOString() });
}

/**
 * "Snooze" — push the follow-up date out by `months` from wherever it sits
 * now, and un-dismiss so it comes back when the new date arrives.
 */
export function snoozeFollowup(patientId: string, months = 1): void {
  const summary = followupForPatient(patientId);
  const from = summary?.followup_date ?? new Date().toISOString().slice(0, 10);
  patients.setFollowupState(patientId, {
    followup_date_override: addMonths(toInstant(from), months).slice(0, 10),
    followup_dismissed_at: null,
  });
}

/** After a recall email goes out: record it and treat the cycle as handled. */
export function recordFollowupEmail(patientId: string): void {
  const now = new Date().toISOString();
  patients.setFollowupState(patientId, {
    followup_last_emailed_at: now,
    followup_dismissed_at: now,
  });
}

// ── Email ──

function humanInterval(months: number): { elapsed: string; cadence: string } {
  if (months <= 12) return { elapsed: 'a year', cadence: 'every year' };
  if (months === 24) return { elapsed: 'two years', cadence: 'every two years' };
  return { elapsed: `${months} months`, cadence: `every ${months} months` };
}

/**
 * Drafts the recall email. Plain and factual — it sends from the
 * business's own mailbox and the operator reads it before it goes out.
 * Mirrors `composeReminder` in reminders.ts: the wording comes from the
 * `followup` email template (built-in default unless the operator edited
 * it in Settings) and this fills in the per-patient placeholders.
 */
export function composeFollowupEmail(opts: {
  patient: PatientRow;
  lastAppointmentAt: string | null;
}): { subject: string; body: string } {
  const business = process.env.BUSINESS_NAME || 'Viewpoint Vision Care';
  const firstName = opts.patient.full_name.split(/\s+/)[0];
  const months = recallIntervalMonths(
    opts.patient.date_of_birth,
    opts.lastAppointmentAt ?? new Date().toISOString(),
  );
  const { elapsed, cadence } = humanInterval(months);
  const historySentence = opts.lastAppointmentAt
    ? `Our records show it has been about ${elapsed} since your last eye exam at ${business}.`
    : `Our records show you are due for an eye exam at ${business}.`;

  return renderEmailTemplate('followup', {
    firstName,
    business,
    historySentence,
    elapsed,
    cadence,
  });
}
