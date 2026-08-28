import { v4 as uuid } from 'uuid';
import { getDb } from '../db/db.js';
import type { AppointmentRow, AppointmentSource, AppointmentStatus } from '../db/practice.js';
import type { CalendarEvent } from './google-calendar.js';

/**
 * Appointments, mirrored from Google Calendar.
 *
 * The calendar stays the source of truth for scheduling — the operator
 * keeps booking wherever they already do — and this table exists so the
 * app can attach patients, eligibility checks, invoices, and reminders to
 * an appointment.
 */

export function getAppointment(id: string): AppointmentRow | undefined {
  return getDb().prepare(`SELECT * FROM appointments WHERE id = ?`).get(id) as
    | AppointmentRow
    | undefined;
}

export function findByGoogleEventId(eventId: string): AppointmentRow | undefined {
  return getDb().prepare(`SELECT * FROM appointments WHERE google_event_id = ?`).get(eventId) as
    | AppointmentRow
    | undefined;
}

export function listUpcoming(fromIso?: string, limit = 200): AppointmentRow[] {
  const from = fromIso ?? new Date().toISOString();
  return getDb()
    .prepare(
      `SELECT * FROM appointments
       WHERE starts_at >= ? AND status != 'cancelled'
       ORDER BY starts_at ASC LIMIT ?`,
    )
    .all(from, limit) as AppointmentRow[];
}

export function listBetween(startIso: string, endIso: string): AppointmentRow[] {
  return getDb()
    .prepare(`SELECT * FROM appointments WHERE starts_at >= ? AND starts_at <= ? ORDER BY starts_at ASC`)
    .all(startIso, endIso) as AppointmentRow[];
}

export function listForPatient(patientId: string): AppointmentRow[] {
  return getDb()
    .prepare(`SELECT * FROM appointments WHERE patient_id = ? ORDER BY starts_at DESC`)
    .all(patientId) as AppointmentRow[];
}

export interface AppointmentInput {
  patientId?: string | null;
  googleEventId?: string | null;
  startsAt: string;
  endsAt?: string | null;
  title?: string | null;
  location?: string | null;
  status?: AppointmentStatus;
  source?: AppointmentSource;
}

export function createAppointment(input: AppointmentInput): AppointmentRow {
  const now = new Date().toISOString();
  const id = uuid();

  getDb()
    .prepare(
      `INSERT INTO appointments (
         id, patient_id, google_event_id, starts_at, ends_at, title,
         location, status, source, created_at, updated_at
       ) VALUES (
         @id, @patient_id, @google_event_id, @starts_at, @ends_at, @title,
         @location, @status, @source, @created_at, @updated_at
       )`,
    )
    .run({
      id,
      patient_id: input.patientId ?? null,
      google_event_id: input.googleEventId ?? null,
      starts_at: input.startsAt,
      ends_at: input.endsAt ?? null,
      title: input.title ?? null,
      location: input.location ?? null,
      status: input.status ?? 'scheduled',
      source: input.source ?? 'manual',
      created_at: now,
      updated_at: now,
    });

  return getAppointment(id)!;
}

/**
 * Mirrors a calendar event into the appointments table.
 *
 * Keyed on google_event_id (UNIQUE), so re-polling the same event updates
 * the existing row instead of duplicating it — the same idempotency
 * guarantee the receipts path gets from Wave's externalId.
 */
export function upsertFromCalendarEvent(
  event: CalendarEvent,
  patientId?: string | null,
): AppointmentRow {
  const existing = findByGoogleEventId(event.id);
  const now = new Date().toISOString();

  if (existing) {
    getDb()
      .prepare(
        `UPDATE appointments SET
           starts_at = @starts_at,
           ends_at = @ends_at,
           title = @title,
           location = @location,
           patient_id = @patient_id,
           updated_at = @updated_at
         WHERE id = @id`,
      )
      .run({
        id: existing.id,
        starts_at: event.startsAt,
        ends_at: event.endsAt,
        title: event.summary,
        location: event.location,
        // Never clear an existing link just because this poll didn't
        // resolve one — the operator may have set it by hand.
        patient_id: patientId ?? existing.patient_id,
        updated_at: now,
      });

    return getAppointment(existing.id)!;
  }

  return createAppointment({
    patientId: patientId ?? null,
    googleEventId: event.id,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    title: event.summary,
    location: event.location,
    source: 'google',
  });
}

export function linkPatient(appointmentId: string, patientId: string): void {
  getDb()
    .prepare(`UPDATE appointments SET patient_id = ?, updated_at = ? WHERE id = ?`)
    .run(patientId, new Date().toISOString(), appointmentId);
}

export function setStatus(appointmentId: string, status: AppointmentStatus): void {
  getDb()
    .prepare(`UPDATE appointments SET status = ?, updated_at = ? WHERE id = ?`)
    .run(status, new Date().toISOString(), appointmentId);
}

export function deleteAppointment(id: string): boolean {
  return getDb().prepare(`DELETE FROM appointments WHERE id = ?`).run(id).changes > 0;
}
