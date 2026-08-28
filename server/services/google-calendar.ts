import { getAccessToken, GoogleAuthError } from './google-auth.js';
import { endpoint } from './endpoints.js';

/**
 * Google Calendar: reading the appointment schedule.
 *
 * The calendar is the source of truth for when appointments are — this
 * app mirrors it rather than owning it, so the operator keeps booking
 * wherever they already do.
 */


export interface CalendarEvent {
  id: string;
  summary: string | null;
  description: string | null;
  location: string | null;
  /** ISO 8601. All-day events surface as the date at local midnight. */
  startsAt: string;
  endsAt: string | null;
  attendeeEmails: string[];
  status: string | null;
}

function calendarId(): string {
  return process.env.GOOGLE_CALENDAR_ID || 'primary';
}

async function calendarFetch(pathAndQuery: string, init: RequestInit = {}): Promise<any> {
  const token = await getAccessToken();

  let res: Response;
  try {
    res = await fetch(`${endpoint('calendarBase')}${pathAndQuery}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new GoogleAuthError('network_error', `Network error: ${(err as Error).message}`);
  }

  if (res.status === 401) {
    throw new GoogleAuthError('not_connected', 'Google rejected the stored credentials. Reconnect in Settings.');
  }

  if (res.status === 429 || res.status >= 500) {
    throw new GoogleAuthError('server_error', `Calendar API error (${res.status}): ${res.statusText}`);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new GoogleAuthError('bad_request', `Calendar API error (${res.status}): ${detail}`);
  }

  return res.json();
}

function toEvent(item: any): CalendarEvent {
  return {
    id: item.id,
    summary: item.summary ?? null,
    description: item.description ?? null,
    location: item.location ?? null,
    // Timed events use dateTime; all-day events only carry `date`.
    startsAt: item.start?.dateTime ?? item.start?.date ?? '',
    endsAt: item.end?.dateTime ?? item.end?.date ?? null,
    attendeeEmails: (item.attendees ?? [])
      .map((a: any) => a.email)
      .filter((e: unknown): e is string => typeof e === 'string'),
    status: item.status ?? null,
  };
}

export async function listEvents(timeMin: Date, timeMax: Date, maxResults = 250): Promise<CalendarEvent[]> {
  const params = new URLSearchParams({
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    // Expands recurring events into their individual occurrences, which
    // is what "the schedule" actually means here.
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: String(maxResults),
  });

  const json = await calendarFetch(
    `/calendars/${encodeURIComponent(calendarId())}/events?${params.toString()}`,
  );

  return (json.items ?? [])
    .filter((item: any) => item.status !== 'cancelled')
    .map(toEvent);
}

export async function getEvent(eventId: string): Promise<CalendarEvent> {
  const json = await calendarFetch(
    `/calendars/${encodeURIComponent(calendarId())}/events/${encodeURIComponent(eventId)}`,
  );
  return toEvent(json);
}

/**
 * Finds the calendar event an exam request is asking about.
 *
 * Matches on start time within a tolerance, then prefers an event whose
 * attendees or title mention the patient. Returns undefined rather than
 * guessing when nothing lines up — a wrong match would attach the
 * appointment to the wrong person.
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
