import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestApp, type TestContext } from '../helpers/testApp.js';
import { installFetchMock, jsonResponse } from '../helpers/fetchMock.js';

/**
 * `pullCalendar()` — the poller's Outlook-side pull.
 *
 * Property that matters: it mirrors Graph into `appointments` idempotently
 * (keyed on `ms_event_id`), never clobbers a hand-set patient link, and
 * only actually talks to Graph on the delta / re-prime cadence.
 */

const CREDS = { MICROSOFT_CLIENT_ID: 'test-ms-client-id' };

function graphEvent(over: Record<string, any> = {}) {
  return {
    id: 'evt-1',
    '@odata.etag': 'W/"1"',
    iCalUId: 'ical-1',
    subject: 'Eye exam — Ada',
    bodyPreview: '',
    location: { displayName: 'Room 1' },
    start: { dateTime: '2026-09-01T14:00:00.0000000', timeZone: 'UTC' },
    end: { dateTime: '2026-09-01T14:30:00.0000000', timeZone: 'UTC' },
    isAllDay: false,
    type: 'singleInstance',
    seriesMasterId: null,
    webLink: 'https://outlook/evt-1',
    isCancelled: false,
    showAs: 'busy',
    attendees: [],
    ...over,
  };
}

const deltaPage = (value: any[], deltatoken = 'tok-1') => ({
  value,
  '@odata.deltaLink':
    `https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=${deltatoken}`,
});

describe('pullCalendar', () => {
  let ctx: TestContext;
  let sync: typeof import('../../server/exams/calendar-sync.js');
  let appointments: typeof import('../../server/exams/appointments.js');
  let patients: typeof import('../../server/exams/patients.js');
  let store: typeof import('../../server/platform/oauth-store.js');

  beforeEach(async () => {
    ctx = await setupTestApp({ ...CREDS });
    sync = await import('../../server/exams/calendar-sync.js');
    appointments = await import('../../server/exams/appointments.js');
    patients = await import('../../server/exams/patients.js');
    store = await import('../../server/platform/oauth-store.js');
    store.saveTokens('microsoft', {
      accessToken: 'valid-token',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    ctx.teardown();
    delete process.env.MICROSOFT_CLIENT_ID;
  });

  async function readSyncRow() {
    const { getDb } = await import('../../server/db/db.js');
    return getDb().prepare(`SELECT * FROM calendar_sync WHERE calendar_id = 'primary'`).get() as any;
  }

  it('does nothing when Microsoft is not connected', async () => {
    store.disconnect('microsoft');
    const mock = installFetchMock();

    expect(await sync.pullCalendar()).toBeNull();
    expect(mock).not.toHaveBeenCalled();
  });

  it('primes the window on the first pass and stores the delta link', async () => {
    const mock = installFetchMock();
    mock.mockResolvedValue(jsonResponse(200, deltaPage([graphEvent()])));

    const result = await sync.pullCalendar();
    expect(result).toMatchObject({ pulled: 1, primed: true, throttled: false });

    const appt = appointments.listUpcoming('2000-01-01T00:00:00Z')[0];
    expect(appt).toMatchObject({ ms_event_id: 'evt-1', source: 'microsoft', title: 'Eye exam — Ada' });

    const row = await readSyncRow();
    expect(row.delta_link).toContain('$deltatoken=tok-1');
    expect(row.last_full_sync_at).toBeTruthy();
    expect(row.last_delta_at).toBeTruthy();
  });

  it('re-pulling the same event updates the row instead of duplicating it', async () => {
    const mock = installFetchMock();
    mock.mockResolvedValueOnce(jsonResponse(200, deltaPage([graphEvent()])));
    await sync.pullCalendar();

    mock.mockResolvedValueOnce(
      jsonResponse(200, deltaPage([graphEvent({ subject: 'Eye exam — Ada (moved)' })], 'tok-2')),
    );
    await sync.pullCalendar({ force: true });

    const rows = appointments.listUpcoming('2000-01-01T00:00:00Z');
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Eye exam — Ada (moved)');
  });

  it('throttles: a second pass inside the delta window does not hit Graph', async () => {
    const mock = installFetchMock();
    mock.mockResolvedValue(jsonResponse(200, deltaPage([graphEvent()])));
    await sync.pullCalendar();
    const callsAfterPrime = mock.mock.calls.length;

    const result = await sync.pullCalendar();
    expect(result).toMatchObject({ throttled: true, pulled: 0 });
    expect(mock.mock.calls.length).toBe(callsAfterPrime);
  });

  it('follows the stored delta link on an incremental (non-prime) pass', async () => {
    const mock = installFetchMock();
    mock.mockResolvedValueOnce(jsonResponse(200, deltaPage([graphEvent()])));
    await sync.pullCalendar();

    mock.mockResolvedValueOnce(jsonResponse(200, deltaPage([], 'tok-2')));
    await sync.pullCalendar({ force: true });

    const lastUrl = String(mock.mock.calls.at(-1)![0]);
    expect(lastUrl).toContain('$deltatoken=tok-1');
  });

  it('cancels the local row when the event is cancelled in Outlook', async () => {
    const mock = installFetchMock();
    mock.mockResolvedValueOnce(jsonResponse(200, deltaPage([graphEvent()])));
    await sync.pullCalendar();

    mock.mockResolvedValueOnce(
      jsonResponse(200, deltaPage([graphEvent({ isCancelled: true })], 'tok-2')),
    );
    await sync.pullCalendar({ force: true });

    const { getDb } = await import('../../server/db/db.js');
    const appt = getDb().prepare(`SELECT * FROM appointments WHERE ms_event_id = 'evt-1'`).get() as any;
    expect(appt.status).toBe('cancelled');
  });

  it('never clears a hand-set patient link on a later pull', async () => {
    const mock = installFetchMock();
    mock.mockResolvedValueOnce(jsonResponse(200, deltaPage([graphEvent()])));
    await sync.pullCalendar();

    const patient = patients.createPatient({ full_name: 'Ada Lovelace' });
    const appt = appointments.findByMsEventId('evt-1')!;
    appointments.linkPatient(appt.id, patient.id);

    mock.mockResolvedValueOnce(jsonResponse(200, deltaPage([graphEvent({ subject: 'x' })], 'tok-2')));
    await sync.pullCalendar({ force: true });

    expect(appointments.findByMsEventId('evt-1')!.patient_id).toBe(patient.id);
  });

  it('re-primes when the stored delta token has expired (410)', async () => {
    const mock = installFetchMock();
    mock.mockResolvedValueOnce(jsonResponse(200, deltaPage([graphEvent()])));
    await sync.pullCalendar();

    // Force pass: stored link → 410, then a fresh initial walk.
    mock
      .mockResolvedValueOnce(jsonResponse(410, { error: { code: 'syncStateNotFound' } }))
      .mockResolvedValueOnce(jsonResponse(200, deltaPage([graphEvent({ id: 'evt-2' })], 'tok-3')));

    const result = await sync.pullCalendar({ force: true });
    expect(result).toMatchObject({ primed: true });
    expect(appointments.findByMsEventId('evt-2')).toBeTruthy();

    const row = await readSyncRow();
    expect(row.delta_link).toContain('tok-3');
  });

  it('re-primes weekly even with a valid delta link', async () => {
    const mock = installFetchMock();
    mock.mockResolvedValueOnce(jsonResponse(200, deltaPage([graphEvent()])));
    await sync.pullCalendar();

    const { getDb } = await import('../../server/db/db.js');
    getDb()
      .prepare(`UPDATE calendar_sync SET last_full_sync_at = ?, last_delta_at = ? WHERE calendar_id = 'primary'`)
      .run(
        new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString(),
        new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString(),
      );

    // A prime ignores the stored token and walks from the window start.
    mock.mockResolvedValueOnce(jsonResponse(200, deltaPage([graphEvent()], 'tok-4')));
    const result = await sync.pullCalendar();
    expect(result).toMatchObject({ primed: true });
    expect(String(mock.mock.calls.at(-1)![0])).toContain('startDateTime=');
  });

  it('calendarSyncStatus reports connection and freshness', async () => {
    const mock = installFetchMock();
    mock.mockResolvedValue(jsonResponse(200, deltaPage([graphEvent()])));

    expect(sync.calendarSyncStatus()).toMatchObject({ connected: true, calendarId: 'primary', lastSyncedAt: null });
    await sync.pullCalendar();
    expect(sync.calendarSyncStatus().lastSyncedAt).toBeTruthy();
  });
});

describe('pushPending', () => {
  let ctx: TestContext;
  let sync: typeof import('../../server/exams/calendar-sync.js');
  let appointments: typeof import('../../server/exams/appointments.js');
  let store: typeof import('../../server/platform/oauth-store.js');

  beforeEach(async () => {
    ctx = await setupTestApp({ ...CREDS });
    sync = await import('../../server/exams/calendar-sync.js');
    appointments = await import('../../server/exams/appointments.js');
    store = await import('../../server/platform/oauth-store.js');
    store.saveTokens('microsoft', {
      accessToken: 'valid-token',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    ctx.teardown();
    delete process.env.MICROSOFT_CLIENT_ID;
  });

  const flag = (id: string) => appointments.setPushState(id, 'pending_push');
  const graphEventBody = (over: Record<string, unknown> = {}) =>
    jsonResponse(200, {
      id: 'ms-1',
      '@odata.etag': 'W/"9"',
      webLink: 'https://outlook/ms-1',
      subject: 'x',
      start: { dateTime: '2026-09-01T14:00:00', timeZone: 'UTC' },
      ...over,
    });

  it('does nothing when Microsoft is not connected', async () => {
    store.disconnect('microsoft');
    const a = appointments.createAppointment({ startsAt: '2026-09-01T14:00:00.000Z', source: 'manual' });
    flag(a.id);
    const mock = installFetchMock();

    expect(await sync.pushPending()).toBe(0);
    expect(mock).not.toHaveBeenCalled();
  });

  it('creates the Outlook event for a never-synced pending row', async () => {
    const a = appointments.createAppointment({
      startsAt: '2026-09-01T14:00:00.000Z',
      title: 'Walk-in',
      source: 'manual',
    });
    flag(a.id);

    const mock = installFetchMock();
    mock.mockResolvedValue(graphEventBody());

    expect(await sync.pushPending()).toBe(1);
    const after = appointments.getAppointment(a.id)!;
    expect(after.ms_event_id).toBe('ms-1');
    expect(after.sync_state).toBe('synced');
    expect(mock.mock.calls[0][1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse((mock.mock.calls[0][1] as RequestInit).body as string).transactionId).toBe(a.id);
  });

  it('updates the Outlook event for a synced-then-edited pending row', async () => {
    const a = appointments.createAppointment({
      startsAt: '2026-09-01T14:00:00.000Z',
      msEventId: 'ms-1',
      etag: 'W/"1"',
      source: 'microsoft',
    });
    appointments.updateAppointment(a.id, { title: 'Renamed' });
    flag(a.id);

    const mock = installFetchMock();
    mock.mockResolvedValue(graphEventBody({ '@odata.etag': 'W/"2"' }));

    expect(await sync.pushPending()).toBe(1);
    expect(mock.mock.calls[0][1]).toMatchObject({ method: 'PATCH' });
    expect((mock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ 'If-Match': 'W/"1"' });
    expect(appointments.getAppointment(a.id)!.sync_state).toBe('synced');
  });

  it('tombstones the Outlook event for a cancelled pending row', async () => {
    const a = appointments.createAppointment({
      startsAt: '2026-09-01T14:00:00.000Z',
      msEventId: 'ms-1',
      etag: 'W/"1"',
      title: 'Eye exam',
      source: 'microsoft',
    });
    appointments.setStatus(a.id, 'cancelled');
    flag(a.id);

    const mock = installFetchMock();
    mock.mockResolvedValue(graphEventBody({ subject: 'Cancelled — Eye exam' }));

    expect(await sync.pushPending()).toBe(1);
    const body = JSON.parse((mock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.subject).toBe('Cancelled — Eye exam');
    expect(body.showAs).toBe('free');
    const after = appointments.getAppointment(a.id)!;
    expect(after.status).toBe('cancelled');
    expect(after.sync_state).toBe('synced');
  });

  it('leaves the row flagged when the connection is down', async () => {
    const a = appointments.createAppointment({ startsAt: '2026-09-01T14:00:00.000Z', source: 'manual' });
    flag(a.id);

    const mock = installFetchMock();
    mock.mockResolvedValue(jsonResponse(503, {}));

    expect(await sync.pushPending()).toBe(0);
    expect(appointments.getAppointment(a.id)!.sync_state).toBe('pending_push');
  });

  it('marks push_failed on a non-retryable rejection', async () => {
    const a = appointments.createAppointment({ startsAt: '2026-09-01T14:00:00.000Z', source: 'manual' });
    flag(a.id);

    const mock = installFetchMock();
    mock.mockResolvedValue(jsonResponse(400, { error: { message: 'bad' } }));

    await sync.pushPending();
    expect(appointments.getAppointment(a.id)!.sync_state).toBe('push_failed');
  });

  it('runs on the poller pass', async () => {
    const a = appointments.createAppointment({ startsAt: '2026-09-01T14:00:00.000Z', source: 'manual' });
    flag(a.id);

    const mock = installFetchMock();
    mock
      .mockResolvedValueOnce(graphEventBody()) // the create
      .mockResolvedValueOnce(
        jsonResponse(200, {
          value: [],
          '@odata.deltaLink':
            'https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=t',
        }),
      );

    const result = await sync.pullCalendar({ force: true });
    expect(result).toMatchObject({ pushed: 1 });
    expect(appointments.getAppointment(a.id)!.sync_state).toBe('synced');
  });
});
