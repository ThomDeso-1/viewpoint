import { graphFetch, graphJson } from './client.js';

/**
 * The Outlook / Microsoft 365 calendar — the app's appointment calendar
 * from Phase 1 on.
 *
 * Mirrors the surface of the (Phase 3 — soon-deleted) Google client in
 * `integrations/google/calendar.ts`: `listEvents` / `getEvent` /
 * `createEvent` / `updateEvent` / `deleteEvent` / `matchEvent`, plus a
 * `deltaSync` the poller uses to pull Outlook-side changes cheaply.
 *
 * Times are handled explicitly rather than relying on the mailbox's
 * default zone: reads ask Graph for UTC (`Prefer: outlook.timezone`),
 * writes send a `dateTime` + `timeZone` pair. Outlook stays canonical —
 * the app only ever round-trips subject, time and location.
 */

export interface CalendarEvent {
  id: string;
  /** Graph `iCalUId` — stable across a recurring series' occurrences. */
  iCalUId: string | null;
  summary: string | null;
  description: string | null;
  location: string | null;
  /** ISO 8601 instant. All-day events surface as UTC midnight of the date. */
  startsAt: string;
  endsAt: string | null;
  isAllDay: boolean;
  attendeeEmails: string[];
  /** singleInstance | occurrence | exception | seriesMaster */
  type: string;
  seriesMasterId: string | null;
  webLink: string | null;
  /** `@odata.etag` — sent back as `If-Match` so an Outlook-side edit wins. */
  etag: string | null;
  /**
   * True for an event cancelled in Outlook *or* deleted there (a delta
   * `@removed` tombstone) — the app treats both as "cancel the local row".
   */
  isCancelled: boolean;
  status: string | null;
}

const EVENT_SELECT =
  'id,iCalUId,subject,bodyPreview,location,start,end,isAllDay,type,seriesMasterId,webLink,isCancelled,showAs,attendees';

/** Read times back in UTC, so `dateTime` is an unambiguous wall clock. */
const READ_TIMEZONE = 'outlook.timezone="UTC"';

/** The window `calendarView` / `calendarView/delta` operate over. */
export const SYNC_WINDOW_BACK_MS = 7 * 24 * 60 * 60 * 1000;
export const SYNC_WINDOW_FORWARD_MS = 180 * 24 * 60 * 60 * 1000;

export function calendarId(): string {
  return process.env.MICROSOFT_CALENDAR_ID || 'primary';
}

/** `/me/events` for the default calendar, `/me/calendars/{id}/events` otherwise. */
function eventsBase(): string {
  const id = calendarId();
  return id === 'primary' ? '/me/events' : `/me/calendars/${encodeURIComponent(id)}/events`;
}

function calendarViewBase(): string {
  const id = calendarId();
  return id === 'primary'
    ? '/me/calendarView'
    : `/me/calendars/${encodeURIComponent(id)}/calendarView`;
}

/** Graph's `dateTime` has no offset; its sibling `timeZone` says how to read it. */
function toInstant(slot: { dateTime?: string; timeZone?: string } | undefined): string | null {
  if (!slot?.dateTime) return null;
  const raw = slot.dateTime;
  // We ask for UTC on reads, so an offset-less value is UTC wall clock.
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw)) return new Date(raw).toISOString();
  const parsed = new Date(`${raw}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function toEvent(item: any): CalendarEvent {
  // A delta `@removed` entry carries only an id.
  if (item['@removed']) {
    return {
      id: item.id,
      iCalUId: null,
      summary: null,
      description: null,
      location: null,
      startsAt: '',
      endsAt: null,
      isAllDay: false,
      attendeeEmails: [],
      type: 'singleInstance',
      seriesMasterId: null,
      webLink: null,
      etag: null,
      isCancelled: true,
      status: 'removed',
    };
  }

  return {
    id: item.id,
    iCalUId: item.iCalUId ?? null,
    summary: item.subject ?? null,
    description: item.bodyPreview ?? null,
    location: item.location?.displayName || null,
    startsAt: toInstant(item.start) ?? '',
    endsAt: toInstant(item.end),
    isAllDay: !!item.isAllDay,
    attendeeEmails: (item.attendees ?? [])
      .map((a: any) => a.emailAddress?.address)
      .filter((e: unknown): e is string => typeof e === 'string'),
    type: item.type ?? 'singleInstance',
    seriesMasterId: item.seriesMasterId ?? null,
    webLink: item.webLink ?? null,
    etag: item['@odata.etag'] ?? null,
    isCancelled: !!item.isCancelled,
    status: item.showAs ?? null,
  };
}

/** Walks `@odata.nextLink` and returns every page's `value` concatenated. */
async function collectPages(firstUrl: string): Promise<any[]> {
  const items: any[] = [];
  let url: string | undefined = firstUrl;

  while (url) {
    const json: any = await graphJson(url, {
      headers: { Prefer: READ_TIMEZONE },
    });
    if (Array.isArray(json.value)) items.push(...json.value);
    url = json['@odata.nextLink'];
  }

  return items;
}

export async function listEvents(from: Date, to: Date): Promise<CalendarEvent[]> {
  const params = new URLSearchParams({
    startDateTime: from.toISOString(),
    endDateTime: to.toISOString(),
    $select: EVENT_SELECT,
    $orderby: 'start/dateTime',
    $top: '250',
  });

  const items = await collectPages(`${calendarViewBase()}?${params.toString()}`);
  return items.map(toEvent).filter((e) => !e.isCancelled);
}

export async function getEvent(eventId: string): Promise<CalendarEvent> {
  const json = await graphJson(
    `${eventsBase()}/${encodeURIComponent(eventId)}?$select=${EVENT_SELECT}`,
    { headers: { Prefer: READ_TIMEZONE } },
  );
  return toEvent(json);
}

export interface CalendarEventInput {
  summary: string;
  description?: string | null;
  location?: string | null;
  /** ISO 8601 instant. */
  startsAt: string;
  /** ISO 8601 instant; defaults to 30 minutes after the start. */
  endsAt?: string | null;
  /**
   * Client-supplied idempotency key. Graph drops a POST whose
   * `transactionId` it has already seen (recent window), so a retried
   * create after a lost response does not double-book.
   */
  transactionId?: string;
}

/** Graph wants a zone-less wall clock plus a named zone — send UTC of the instant. */
function toGraphSlot(iso: string): { dateTime: string; timeZone: string } {
  // "2026-09-01T14:00:00.000Z" -> "2026-09-01T14:00:00" + UTC
  return { dateTime: new Date(iso).toISOString().replace(/\.\d{3}Z$/, ''), timeZone: 'UTC' };
}

/**
 * Creates an event for an appointment that came from a scanned file. No
 * attendees and no Outlook reminder — this mirrors the office schedule,
 * it does not email the patient (the app sends its own reminders).
 */
export async function createEvent(input: CalendarEventInput): Promise<CalendarEvent> {
  const start = new Date(input.startsAt);
  const end = input.endsAt ? new Date(input.endsAt) : new Date(start.getTime() + 30 * 60 * 1000);

  const json = await graphJson(eventsBase(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: READ_TIMEZONE },
    body: JSON.stringify({
      subject: input.summary,
      body: input.description ? { contentType: 'text', content: input.description } : undefined,
      location: input.location ? { displayName: input.location } : undefined,
      start: toGraphSlot(start.toISOString()),
      end: toGraphSlot(end.toISOString()),
      isReminderOn: false,
      ...(input.transactionId ? { transactionId: input.transactionId } : {}),
    }),
  });

  return toEvent(json);
}

/**
 * Marks an event cancelled without deleting it — a tombstone the front
 * desk still sees in Outlook. Graph's `isCancelled` is not directly
 * settable on a no-attendee event and `/cancel` only applies to meetings
 * with attendees, so this frees the slot (`showAs: 'free'`), tags it
 * `Cancelled`, and prefixes the subject. `etag` → `If-Match`; `412` is
 * surfaced like `updateEvent`.
 */
export async function tombstoneEvent(
  eventId: string,
  subject: string,
  etag?: string | null,
): Promise<{ event: CalendarEvent | null; conflict: boolean }> {
  const prefixed = subject.startsWith('Cancelled — ') ? subject : `Cancelled — ${subject}`;

  const res = await graphFetch(
    `${eventsBase()}/${encodeURIComponent(eventId)}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Prefer: READ_TIMEZONE,
        ...(etag ? { 'If-Match': etag } : {}),
      },
      body: JSON.stringify({ subject: prefixed, showAs: 'free', categories: ['Cancelled'] }),
    },
    { allow: [412] },
  );

  if (res.status === 412) return { event: null, conflict: true };
  return { event: toEvent(await res.json()), conflict: false };
}

export interface CalendarEventPatch {
  summary?: string;
  location?: string | null;
  startsAt?: string;
  endsAt?: string | null;
}

/**
 * Patches subject / time / location. `etag`, when given, is sent as
 * `If-Match`; a `412` means Outlook changed first and is surfaced (not
 * thrown) so the caller can re-pull.
 */
export async function updateEvent(
  eventId: string,
  patch: CalendarEventPatch,
  etag?: string | null,
): Promise<{ event: CalendarEvent | null; conflict: boolean }> {
  const body: Record<string, unknown> = {};
  if (patch.summary !== undefined) body.subject = patch.summary;
  if (patch.location !== undefined) {
    body.location = patch.location ? { displayName: patch.location } : { displayName: '' };
  }
  if (patch.startsAt !== undefined) body.start = toGraphSlot(patch.startsAt);
  if (patch.endsAt) body.end = toGraphSlot(patch.endsAt);

  const res = await graphFetch(
    `${eventsBase()}/${encodeURIComponent(eventId)}`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Prefer: READ_TIMEZONE,
        ...(etag ? { 'If-Match': etag } : {}),
      },
      body: JSON.stringify(body),
    },
    { allow: [412] },
  );

  if (res.status === 412) return { event: null, conflict: true };
  return { event: toEvent(await res.json()), conflict: false };
}

export async function deleteEvent(eventId: string): Promise<void> {
  await graphFetch(
    `${eventsBase()}/${encodeURIComponent(eventId)}`,
    { method: 'DELETE' },
    { allow: [404] },
  );
}

export interface DeltaResult {
  events: CalendarEvent[];
  /** The `@odata.deltaLink` to pass next time, or null if none was returned. */
  deltaLink: string | null;
  /** True when the stored token was rejected (`410 Gone`) — caller re-primes. */
  expired: boolean;
}

/**
 * Pulls Outlook-side changes.
 *
 * With no `deltaLink` this is a full prime over `now-7d … now+180d`; with
 * one it returns only what changed since. A `410 Gone` means the token
 * aged out — `expired` is set and the caller starts over with no token.
 */
export async function deltaSync(deltaLink?: string | null): Promise<DeltaResult> {
  let url: string;
  if (deltaLink) {
    url = deltaLink;
  } else {
    const now = Date.now();
    const params = new URLSearchParams({
      startDateTime: new Date(now - SYNC_WINDOW_BACK_MS).toISOString(),
      endDateTime: new Date(now + SYNC_WINDOW_FORWARD_MS).toISOString(),
      $select: EVENT_SELECT,
    });
    url = `${calendarViewBase()}/delta?${params.toString()}`;
  }

  const events: CalendarEvent[] = [];
  let nextDeltaLink: string | null = null;

  // Follow nextLink pages until the deltaLink appears.
  for (;;) {
    const res = await graphFetch(url, { headers: { Prefer: READ_TIMEZONE } }, { allow: [410] });
    if (res.status === 410) return { events: [], deltaLink: null, expired: true };

    const json: any = await res.json();
    if (Array.isArray(json.value)) events.push(...json.value.map(toEvent));

    if (json['@odata.nextLink']) {
      url = json['@odata.nextLink'];
      continue;
    }
    nextDeltaLink = json['@odata.deltaLink'] ?? null;
    break;
  }

  return { events, deltaLink: nextDeltaLink, expired: false };
}

/**
 * Finds the calendar event an exam request is asking about.
 *
 * Matches on start time within a tolerance, then prefers an event whose
 * attendees or title mention the patient. Returns undefined rather than
 * guessing when nothing lines up — a wrong match attaches the appointment
 * to the wrong person. (Copied from the Google client; the shape is the
 * same and that file goes away in Phase 3.)
 */
export function matchEvent(
  events: CalendarEvent[],
  opts: { requestedAt: Date; patientName?: string | null; patientEmail?: string | null },
  toleranceMs = 60 * 60 * 1000,
): CalendarEvent | undefined {
  const target = opts.requestedAt.getTime();

  const nearby = events.filter((e) => {
    const start = new Date(e.startsAt).getTime();
    return Number.isFinite(start) && Math.abs(start - target) <= toleranceMs;
  });

  if (nearby.length === 0) return undefined;
  if (nearby.length === 1) return nearby[0];

  const email = opts.patientEmail?.toLowerCase();
  const name = opts.patientName?.toLowerCase();

  const identified = nearby.find((e) => {
    if (email && e.attendeeEmails.some((a) => a.toLowerCase() === email)) return true;
    if (name && e.summary?.toLowerCase().includes(name)) return true;
    return false;
  });

  if (identified) return identified;

  // Several candidates and nothing to tell them apart — let the operator
  // pick rather than attaching the appointment to the wrong patient.
  return undefined;
}
