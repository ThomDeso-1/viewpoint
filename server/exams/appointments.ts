import { v4 as uuid } from 'uuid';
import { getDb } from '../db/db.js';
import type { AppointmentRow, AppointmentSource, AppointmentStatus, SyncState } from './types.js';
import type { CalendarEvent } from '../integrations/microsoft/calendar.js';

/**
 * Appointments, mirrored from the Outlook / Microsoft 365 calendar.
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

export function findByMsEventId(eventId: string): AppointmentRow | undefined {
  return getDb().prepare(`SELECT * FROM appointments WHERE ms_event_id = ?`).get(eventId) as
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
  msEventId?: string | null;
  icalUid?: string | null;
  etag?: string | null;
  webLink?: string | null;
  isRecurring?: boolean;
  seriesMasterId?: string | null;
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
         id, patient_id, ms_event_id, ical_uid, provider_etag, web_link,
         is_recurring, series_master_id, last_synced_at, sync_state,
         starts_at, ends_at, title, location, status, source, created_at, updated_at
       ) VALUES (
         @id, @patient_id, @ms_event_id, @ical_uid, @provider_etag, @web_link,
         @is_recurring, @series_master_id, @last_synced_at, 'synced',
         @starts_at, @ends_at, @title, @location, @status, @source, @created_at, @updated_at
       )`,
    )
    .run({
      id,
      patient_id: input.patientId ?? null,
      ms_event_id: input.msEventId ?? null,
      ical_uid: input.icalUid ?? null,
      provider_etag: input.etag ?? null,
      web_link: input.webLink ?? null,
      is_recurring: input.isRecurring ? 1 : 0,
      series_master_id: input.seriesMasterId ?? null,
      last_synced_at: input.msEventId ? now : null,
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

const RECURRING_TYPES = new Set(['occurrence', 'exception', 'seriesMaster']);

/**
 * Mirrors a calendar event into the appointments table.
 *
 * Keyed on ms_event_id (UNIQUE index), so re-polling the same event
 * updates the existing row instead of duplicating it — the same
 * idempotency guarantee the receipts path gets from Wave's externalId.
 * An event cancelled or deleted in Outlook flips the row to `cancelled`
 * rather than removing it, so anything attached to it survives.
 */
export function upsertFromCalendarEvent(
  event: CalendarEvent,
  patientId?: string | null,
): AppointmentRow {
  const existing = findByMsEventId(event.id);
  const now = new Date().toISOString();

  if (event.isCancelled) {
    if (existing && existing.status !== 'cancelled') {
      getDb()
        .prepare(
          `UPDATE appointments SET status = 'cancelled', last_synced_at = ?, updated_at = ? WHERE id = ?`,
        )
        .run(now, now, existing.id);
    }
    return existing ? getAppointment(existing.id)! : synthesizeCancelled(event, now);
  }

  const isRecurring = RECURRING_TYPES.has(event.type) ? 1 : 0;

  if (existing) {
    getDb()
      .prepare(
        `UPDATE appointments SET
           starts_at = @starts_at,
           ends_at = @ends_at,
           title = @title,
           location = @location,
           ical_uid = @ical_uid,
           provider_etag = @provider_etag,
           web_link = @web_link,
           is_recurring = @is_recurring,
           series_master_id = @series_master_id,
           source = 'microsoft',
           sync_state = 'synced',
           last_synced_at = @now,
           patient_id = @patient_id,
           updated_at = @now
         WHERE id = @id`,
      )
      .run({
        id: existing.id,
        starts_at: event.startsAt,
        ends_at: event.endsAt,
        title: event.summary,
        location: event.location,
        ical_uid: event.iCalUId,
        provider_etag: event.etag,
        web_link: event.webLink,
        is_recurring: isRecurring,
        series_master_id: event.seriesMasterId,
        // Never clear an existing link just because this poll didn't
        // resolve one — the operator may have set it by hand.
        patient_id: patientId ?? existing.patient_id,
        now,
      });

    return getAppointment(existing.id)!;
  }

  return createAppointment({
    patientId: patientId ?? null,
    msEventId: event.id,
    icalUid: event.iCalUId,
    etag: event.etag,
    webLink: event.webLink,
    isRecurring: isRecurring === 1,
    seriesMasterId: event.seriesMasterId,
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    title: event.summary,
    location: event.location,
    source: 'microsoft',
  });
}

/** A cancellation for an event we never mirrored — record it so a later reappearance is idempotent. */
function synthesizeCancelled(event: CalendarEvent, now: string): AppointmentRow {
  return createAppointment({
    msEventId: event.id,
    startsAt: event.startsAt || now,
    status: 'cancelled',
    source: 'microsoft',
  });
}

/**
 * Records the Graph event id after an approved file-sourced appointment
 * has been written to Outlook. The row is now a mirror of a real calendar
 * event, so its source becomes `microsoft`.
 */
export function setMicrosoftEventId(appointmentId: string, event: CalendarEvent): void {
  getDb()
    .prepare(
      `UPDATE appointments SET
         ms_event_id = @ms_event_id,
         ical_uid = @ical_uid,
         provider_etag = @provider_etag,
         web_link = @web_link,
         source = 'microsoft',
         sync_state = 'synced',
         last_synced_at = @now,
         updated_at = @now
       WHERE id = @id`,
    )
    .run({
      id: appointmentId,
      ms_event_id: event.id,
      ical_uid: event.iCalUId,
      provider_etag: event.etag,
      web_link: event.webLink,
      now: new Date().toISOString(),
    });
}

export function linkPatient(appointmentId: string, patientId: string): void {
  getDb()
    .prepare(`UPDATE appointments SET patient_id = ?, updated_at = ? WHERE id = ?`)
    .run(patientId, new Date().toISOString(), appointmentId);
}

export interface AppointmentEdit {
  startsAt?: string;
  endsAt?: string | null;
  title?: string | null;
  location?: string | null;
}

/**
 * Local write of the operator-editable fields. The Graph push is the
 * caller's job (routes/exams.ts); this just records the app-side state.
 */
export function updateAppointment(id: string, edit: AppointmentEdit): void {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id, updated_at: new Date().toISOString() };

  if (edit.startsAt !== undefined) {
    sets.push('starts_at = @starts_at');
    params.starts_at = edit.startsAt;
  }
  if (edit.endsAt !== undefined) {
    sets.push('ends_at = @ends_at');
    params.ends_at = edit.endsAt;
  }
  if (edit.title !== undefined) {
    sets.push('title = @title');
    params.title = edit.title;
  }
  if (edit.location !== undefined) {
    sets.push('location = @location');
    params.location = edit.location;
  }
  if (sets.length === 0) return;

  getDb()
    .prepare(`UPDATE appointments SET ${sets.join(', ')}, updated_at = @updated_at WHERE id = @id`)
    .run(params);
}

/** After a successful Graph push: refresh the ETag / link and clear the flag. */
export function markPushed(appointmentId: string, event: CalendarEvent): void {
  const now = new Date().toISOString();
  getDb()
    .prepare(
      `UPDATE appointments SET
         provider_etag = @provider_etag,
         web_link = COALESCE(@web_link, web_link),
         sync_state = 'synced',
         last_synced_at = @now,
         updated_at = @now
       WHERE id = @id`,
    )
    .run({ id: appointmentId, provider_etag: event.etag, web_link: event.webLink, now });
}

/** Flags a row whose synchronous Graph push failed, for the poller to retry. */
export function setPushState(appointmentId: string, state: SyncState): void {
  getDb()
    .prepare(`UPDATE appointments SET sync_state = ?, updated_at = ? WHERE id = ?`)
    .run(state, new Date().toISOString(), appointmentId);
}

/** Rows whose last push did not land — retried by `calendar-sync.pushPending()`. */
export function listPendingPush(): AppointmentRow[] {
  return getDb()
    .prepare(`SELECT * FROM appointments WHERE sync_state IN ('pending_push', 'push_failed')`)
    .all() as AppointmentRow[];
}

export function setStatus(appointmentId: string, status: AppointmentStatus): void {
  getDb()
    .prepare(`UPDATE appointments SET status = ?, updated_at = ? WHERE id = ?`)
    .run(status, new Date().toISOString(), appointmentId);
}

export function deleteAppointment(id: string): boolean {
  return getDb().prepare(`DELETE FROM appointments WHERE id = ?`).run(id).changes > 0;
}
