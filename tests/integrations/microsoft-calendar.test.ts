import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestApp, type TestContext } from '../helpers/testApp.js';
import { installFetchMock, jsonResponse } from '../helpers/fetchMock.js';

/**
 * The Outlook / Microsoft 365 calendar client — event mapping, the
 * `calendarView` list, the `calendarView/delta` walk, and single-event
 * CRUD, all against a mocked Graph.
 */

const CREDS = { MICROSOFT_CLIENT_ID: 'test-ms-client-id' };

function msEvent(over: Record<string, any> = {}) {
  return {
    id: 'evt-1',
    '@odata.etag': 'W/"abc"',
    iCalUId: 'ical-1',
    subject: 'Eye exam — Ada Lovelace',
    bodyPreview: 'Annual check',
    location: { displayName: '123 Demo Street' },
    start: { dateTime: '2026-09-01T14:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-09-01T14:30:00.0000000', timeZone: 'UTC' },
    isAllDay: false,
    type: 'singleInstance',
    seriesMasterId: null,
    webLink: 'https://outlook.office365.com/calendar/item/evt-1',
    isCancelled: false,
    showAs: 'busy',
    attendees: [{ emailAddress: { address: 'ada@example.com' } }],
    ...over,
  };
}

describe('Outlook calendar client', () => {
  let ctx: TestContext;
  let calendar: typeof import('../../server/integrations/microsoft/calendar.js');

  beforeEach(async () => {
    ctx = await setupTestApp({ ...CREDS });
    calendar = await import('../../server/integrations/microsoft/calendar.js');
    const store = await import('../../server/platform/oauth-store.js');
    store.saveTokens('microsoft', {
      accessToken: 'valid-token',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    ctx.teardown();
    delete process.env.MICROSOFT_CLIENT_ID;
    delete process.env.MICROSOFT_CALENDAR_ID;
  });

  describe('listEvents', () => {
    it('maps a Graph event onto the CalendarEvent shape', async () => {
      const mock = installFetchMock();
      mock.mockResolvedValue(jsonResponse(200, { value: [msEvent()] }));

      const [event] = await calendar.listEvents(new Date('2026-09-01'), new Date('2026-09-08'));

      expect(event).toMatchObject({
        id: 'evt-1',
        iCalUId: 'ical-1',
        summary: 'Eye exam — Ada Lovelace',
        description: 'Annual check',
        location: '123 Demo Street',
        startsAt: '2026-09-01T14:00:00.000Z',
        endsAt: '2026-09-01T14:30:00.000Z',
        attendeeEmails: ['ada@example.com'],
        type: 'singleInstance',
        webLink: 'https://outlook.office365.com/calendar/item/evt-1',
        etag: 'W/"abc"',
        isCancelled: false,
      });
    });

    it('asks for the UTC timezone and the window / select params', async () => {
      const mock = installFetchMock();
      mock.mockResolvedValue(jsonResponse(200, { value: [] }));

      await calendar.listEvents(new Date('2026-09-01T00:00:00Z'), new Date('2026-09-08T00:00:00Z'));

      const [url, init] = mock.mock.calls[0];
      expect(String(url)).toContain('/me/calendarView?');
      expect(String(url)).toContain('startDateTime=2026-09-01T00%3A00%3A00.000Z');
      expect(String(url)).toContain('%24select=');
      expect(String(url)).toContain('%24orderby=start%2FdateTime');
      expect((init as RequestInit).headers).toMatchObject({ Prefer: 'outlook.timezone="UTC"' });
    });

    it('follows @odata.nextLink and concatenates the pages', async () => {
      const mock = installFetchMock();
      mock
        .mockResolvedValueOnce(
          jsonResponse(200, {
            value: [msEvent({ id: 'a' })],
            '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=p2',
          }),
        )
        .mockResolvedValueOnce(jsonResponse(200, { value: [msEvent({ id: 'b' })] }));

      const events = await calendar.listEvents(new Date('2026-09-01'), new Date('2026-09-08'));
      expect(events.map((e) => e.id)).toEqual(['a', 'b']);
      expect(mock).toHaveBeenCalledTimes(2);
    });

    it('drops events cancelled in Outlook', async () => {
      const mock = installFetchMock();
      mock.mockResolvedValue(
        jsonResponse(200, { value: [msEvent({ id: 'live' }), msEvent({ id: 'dead', isCancelled: true })] }),
      );

      const events = await calendar.listEvents(new Date('2026-09-01'), new Date('2026-09-08'));
      expect(events.map((e) => e.id)).toEqual(['live']);
    });

    it('honours MICROSOFT_CALENDAR_ID', async () => {
      process.env.MICROSOFT_CALENDAR_ID = 'shared-room-cal';
      const mock = installFetchMock();
      mock.mockResolvedValue(jsonResponse(200, { value: [] }));

      await calendar.listEvents(new Date('2026-09-01'), new Date('2026-09-08'));
      expect(String(mock.mock.calls[0][0])).toContain('/me/calendars/shared-room-cal/calendarView');
    });
  });

  describe('createEvent', () => {
    it('POSTs a no-attendee, no-reminder event with an explicit timezone', async () => {
      const mock = installFetchMock();
      mock.mockResolvedValue(jsonResponse(201, msEvent({ id: 'new-1' })));

      const created = await calendar.createEvent({
        summary: 'Eye exam — Bob',
        location: 'Room 2',
        startsAt: '2026-09-02T15:00:00.000Z',
      });

      expect(created.id).toBe('new-1');
      const [url, init] = mock.mock.calls[0];
      expect(String(url)).toContain('/me/events');
      expect((init as RequestInit).method).toBe('POST');
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.subject).toBe('Eye exam — Bob');
      expect(body.start).toEqual({ dateTime: '2026-09-02T15:00:00', timeZone: 'UTC' });
      expect(body.end).toEqual({ dateTime: '2026-09-02T15:30:00', timeZone: 'UTC' });
      expect(body.isReminderOn).toBe(false);
      expect(body.attendees).toBeUndefined();
    });
  });

  describe('updateEvent', () => {
    it('sends the ETag as If-Match and returns the updated event', async () => {
      const mock = installFetchMock();
      mock.mockResolvedValue(jsonResponse(200, msEvent({ subject: 'Moved' })));

      const { event, conflict } = await calendar.updateEvent(
        'evt-1',
        { summary: 'Moved', startsAt: '2026-09-01T16:00:00.000Z' },
        'W/"abc"',
      );

      expect(conflict).toBe(false);
      expect(event?.summary).toBe('Moved');
      const [, init] = mock.mock.calls[0];
      expect((init as RequestInit).method).toBe('PATCH');
      expect((init as RequestInit).headers).toMatchObject({ 'If-Match': 'W/"abc"' });
    });

    it('reports a 412 as a conflict rather than throwing', async () => {
      const mock = installFetchMock();
      mock.mockResolvedValue(jsonResponse(412, { error: { code: 'ErrorIrresolvableConflict' } }));

      const { event, conflict } = await calendar.updateEvent('evt-1', { summary: 'x' }, 'W/"stale"');
      expect(conflict).toBe(true);
      expect(event).toBeNull();
    });
  });

  describe('deltaSync', () => {
    it('primes over a window and returns the deltaLink', async () => {
      const mock = installFetchMock();
      mock.mockResolvedValue(
        jsonResponse(200, {
          value: [msEvent()],
          '@odata.deltaLink':
            'https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=tok-1',
        }),
      );

      const result = await calendar.deltaSync();
      expect(result.expired).toBe(false);
      expect(result.events).toHaveLength(1);
      expect(result.deltaLink).toContain('$deltatoken=tok-1');
      expect(String(mock.mock.calls[0][0])).toContain('/me/calendarView/delta?');
      expect(String(mock.mock.calls[0][0])).toContain('startDateTime=');
    });

    it('walks nextLink pages before the deltaLink', async () => {
      const mock = installFetchMock();
      mock
        .mockResolvedValueOnce(
          jsonResponse(200, {
            value: [msEvent({ id: 'a' })],
            '@odata.nextLink':
              'https://graph.microsoft.com/v1.0/me/calendarView/delta?$skiptoken=s2',
          }),
        )
        .mockResolvedValueOnce(
          jsonResponse(200, {
            value: [msEvent({ id: 'b' })],
            '@odata.deltaLink':
              'https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=tok-2',
          }),
        );

      const result = await calendar.deltaSync();
      expect(result.events.map((e) => e.id)).toEqual(['a', 'b']);
      expect(result.deltaLink).toContain('tok-2');
    });

    it('surfaces a 410 as expired so the caller re-primes', async () => {
      const mock = installFetchMock();
      mock.mockResolvedValue(jsonResponse(410, { error: { code: 'syncStateNotFound' } }));

      const result = await calendar.deltaSync('https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=old');
      expect(result.expired).toBe(true);
      expect(result.deltaLink).toBeNull();
    });

    it('maps a @removed tombstone to a cancellation', async () => {
      const mock = installFetchMock();
      mock.mockResolvedValue(
        jsonResponse(200, {
          value: [{ id: 'gone', '@removed': { reason: 'deleted' } }],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=t',
        }),
      );

      const result = await calendar.deltaSync();
      expect(result.events[0]).toMatchObject({ id: 'gone', isCancelled: true });
    });
  });

  describe('matchEvent', () => {
    const ev = (id: string, startsAt: string, over: Record<string, any> = {}) => ({
      id,
      iCalUId: null,
      summary: null,
      description: null,
      location: null,
      startsAt,
      endsAt: null,
      isAllDay: false,
      attendeeEmails: [],
      type: 'singleInstance',
      seriesMasterId: null,
      webLink: null,
      etag: null,
      isCancelled: false,
      status: null,
      ...over,
    });

    it('matches the single event near the requested time', () => {
      const match = calendar.matchEvent(
        [ev('a', '2026-09-01T10:00:00Z'), ev('b', '2026-09-05T10:00:00Z')],
        { requestedAt: new Date('2026-09-01T10:20:00Z') },
      );
      expect(match?.id).toBe('a');
    });

    it('refuses to guess between indistinguishable candidates', () => {
      const match = calendar.matchEvent(
        [ev('a', '2026-09-01T10:00:00Z'), ev('b', '2026-09-01T10:15:00Z')],
        { requestedAt: new Date('2026-09-01T10:00:00Z') },
      );
      expect(match).toBeUndefined();
    });
  });
});
