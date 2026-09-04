import { getDb } from '../db/db.js';
import * as appointments from './appointments.js';
import { isMicrosoftConnected, MicrosoftAuthError } from '../integrations/microsoft/auth.js';
import {
  deltaSync,
  getEvent,
  createEvent,
  updateEvent,
  tombstoneEvent,
  calendarId,
  SYNC_WINDOW_BACK_MS,
  SYNC_WINDOW_FORWARD_MS,
} from '../integrations/microsoft/calendar.js';
import { audit } from '../platform/audit.js';

/**
 * Pulls Outlook-side calendar changes into the local `appointments` table.
 *
 * The exams poller (`queue.ts`) calls `pullCalendar()` on every pass. A
 * delta query against Graph is cheap but still only runs every few
 * minutes (`CALENDAR_DELTA_MS`); the whole window is re-primed — the delta
 * token discarded and every event re-read — weekly (`CALENDAR_REPRIME_MS`)
 * or whenever Graph rejects the stored token (`410 Gone`).
 *
 * Outlook stays canonical: this only ever writes the local mirror, never
 * the calendar. `POST /api/exams/calendar/sync` runs it with `force`.
 */

export const CALENDAR_DELTA_MS = 3 * 60_000;
export const CALENDAR_REPRIME_MS = 7 * 24 * 60 * 60_000;

interface CalendarSyncRow {
  calendar_id: string;
  delta_link: string | null;
  window_start: string | null;
  window_end: string | null;
  last_full_sync_at: string | null;
  last_delta_at: string | null;
  updated_at: string;
}

function getSyncRow(calId: string): CalendarSyncRow | undefined {
  return getDb().prepare(`SELECT * FROM calendar_sync WHERE calendar_id = ?`).get(calId) as
    | CalendarSyncRow
    | undefined;
}

function saveSyncRow(calId: string, fields: Partial<Omit<CalendarSyncRow, 'calendar_id'>>): void {
  const existing = getSyncRow(calId);
  const now = new Date().toISOString();
  const merged: CalendarSyncRow = {
    calendar_id: calId,
    delta_link: null,
    window_start: null,
    window_end: null,
    last_full_sync_at: null,
    last_delta_at: null,
    ...existing,
    ...fields,
    updated_at: now,
  };

  getDb()
    .prepare(
      `INSERT INTO calendar_sync
         (calendar_id, delta_link, window_start, window_end, last_full_sync_at, last_delta_at, updated_at)
       VALUES (@calendar_id, @delta_link, @window_start, @window_end, @last_full_sync_at, @last_delta_at, @updated_at)
       ON CONFLICT(calendar_id) DO UPDATE SET
         delta_link = @delta_link,
         window_start = @window_start,
         window_end = @window_end,
         last_full_sync_at = @last_full_sync_at,
         last_delta_at = @last_delta_at,
         updated_at = @updated_at`,
    )
    .run(merged);
}

function ageMs(iso: string | null | undefined): number {
  if (!iso) return Infinity;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? Infinity : Date.now() - t;
}

export interface PullResult {
  pulled: number;
  /** Local edits flushed to Outlook this pass (the pending_push retry). */
  pushed: number;
  primed: boolean;
  /** True when the cadence gate short-circuited the *pull* before touching Graph. */
  throttled: boolean;
}

/** Best-effort re-read of one event after a `412` — Outlook wins. */
async function repull(msEventId: string): Promise<void> {
  try {
    appointments.upsertFromCalendarEvent(await getEvent(msEventId));
  } catch {
    // The next full pull reconciles it.
  }
}

/**
 * Retries pushes that a synchronous operator action could not land
 * (`sync_state` still `pending_push` / `push_failed`). The op is inferred
 * from the row: no `ms_event_id` → create, cancelled → tombstone,
 * otherwise → update. A `412` re-pulls (Outlook wins, flag clears); a
 * broken connection leaves everything flagged for the next pass.
 */
export async function pushPending(): Promise<number> {
  if (!isMicrosoftConnected()) return 0;

  let pushed = 0;
  for (const row of appointments.listPendingPush()) {
    try {
      if (!row.ms_event_id && row.status !== 'cancelled') {
        const event = await createEvent({
          summary: row.title ?? 'Appointment',
          location: row.location,
          startsAt: row.starts_at,
          endsAt: row.ends_at,
          transactionId: row.id,
        });
        appointments.setMicrosoftEventId(row.id, event);
      } else if (row.ms_event_id && row.status === 'cancelled') {
        const { event, conflict } = await tombstoneEvent(
          row.ms_event_id,
          row.title ?? 'Appointment',
          row.provider_etag,
        );
        if (conflict) await repull(row.ms_event_id);
        else if (event) appointments.markPushed(row.id, event);
        appointments.setPushState(row.id, 'synced');
      } else if (row.ms_event_id) {
        const { event, conflict } = await updateEvent(
          row.ms_event_id,
          {
            summary: row.title ?? undefined,
            location: row.location,
            startsAt: row.starts_at,
            endsAt: row.ends_at,
          },
          row.provider_etag,
        );
        if (conflict) await repull(row.ms_event_id);
        else if (event) appointments.markPushed(row.id, event);
      } else {
        // A never-synced row that was also cancelled — nothing to push.
        appointments.setPushState(row.id, 'synced');
      }
      pushed++;
    } catch (err) {
      if (err instanceof MicrosoftAuthError) {
        if (!err.isRetryable) {
          appointments.setPushState(row.id, 'push_failed');
          continue;
        }
        // Connection down — stop; the next poll pass tries again.
        break;
      }
      throw err;
    }
  }

  if (pushed > 0) {
    audit({
      action: 'appointment.calendar_sync',
      entityType: 'calendar',
      entityId: calendarId(),
      detail: `${pushed} local edit(s) pushed`,
    });
  }

  return pushed;
}

/**
 * Runs one sync pass. Returns `null` when Microsoft is not connected (the
 * cutover state before the operator signs in) — the caller does nothing.
 */
export async function pullCalendar(opts: { force?: boolean } = {}): Promise<PullResult | null> {
  if (!isMicrosoftConnected()) return null;

  // Flush local edits first, every pass — cheap (one indexed query).
  const pushed = await pushPending();

  const calId = calendarId();
  const row = getSyncRow(calId);

  const needsPrime =
    !row || !row.delta_link || ageMs(row.last_full_sync_at) > CALENDAR_REPRIME_MS;

  if (!opts.force && !needsPrime && ageMs(row?.last_delta_at) < CALENDAR_DELTA_MS) {
    return { pulled: 0, pushed, primed: false, throttled: true };
  }

  let primed = needsPrime;
  let result;
  try {
    result = await deltaSync(primed ? null : row!.delta_link);
    if (result.expired) {
      // Stored token aged out — start the window over.
      primed = true;
      result = await deltaSync(null);
    }
  } catch (err) {
    if (err instanceof MicrosoftAuthError) {
      console.error('[calendar-sync] pull failed:', err.message);
      return null;
    }
    throw err;
  }

  for (const event of result.events) {
    appointments.upsertFromCalendarEvent(event);
  }

  const now = new Date().toISOString();
  saveSyncRow(calId, {
    delta_link: result.deltaLink ?? (primed ? null : row?.delta_link ?? null),
    window_start: new Date(Date.now() - SYNC_WINDOW_BACK_MS).toISOString(),
    window_end: new Date(Date.now() + SYNC_WINDOW_FORWARD_MS).toISOString(),
    last_delta_at: now,
    last_full_sync_at: primed ? now : row?.last_full_sync_at ?? null,
  });

  if (result.events.length > 0) {
    audit({
      action: 'appointment.calendar_sync',
      entityType: 'calendar',
      entityId: calId,
      detail: `${result.events.length} event(s)${primed ? ' (full re-prime)' : ''}`,
    });
  }

  return { pulled: result.events.length, pushed, primed, throttled: false };
}

export interface CalendarSyncStatus {
  connected: boolean;
  calendarId: string;
  lastSyncedAt: string | null;
}

export function calendarSyncStatus(): CalendarSyncStatus {
  const row = getSyncRow(calendarId());
  return {
    connected: isMicrosoftConnected(),
    calendarId: calendarId(),
    lastSyncedAt: row?.last_delta_at ?? row?.last_full_sync_at ?? null,
  };
}
