import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { setupTestApp, type TestContext } from '../helpers/testApp.js';
import { isReadyForRetry } from '../../server/platform/backoff.js';

/**
 * The scanner's "already read this file" ledger: keyed by path, matched
 * by content hash, with a stored back-off for a file that failed to parse.
 */

describe('processed source files', () => {
  let ctx: TestContext;
  let store: typeof import('../../server/exams/processed-files.js');

  beforeEach(async () => {
    ctx = await setupTestApp();
    store = await import('../../server/exams/processed-files.js');
  });
  afterEach(() => ctx.teardown());

  it('records a clean read and keeps the first-seen time across re-reads', async () => {
    store.markOk('sept.csv', 'hash-1', 3);
    const first = store.get('sept.csv')!;
    expect(first.status).toBe('ok');
    expect(first.patients_found).toBe(3);

    store.markOk('sept.csv', 'hash-2', 5);
    const second = store.get('sept.csv')!;
    expect(second.content_hash).toBe('hash-2');
    expect(second.first_seen_at).toBe(first.first_seen_at);
  });

  it('counts files by status', () => {
    store.markOk('a.csv', 'h', 1);
    store.markError('b.csv', 'h', 'bad', false);
    expect(store.countByStatus()).toEqual({ ok: 1, error: 1 });
  });

  it('increments retry_count on each failed read and backs off', () => {
    store.markError('b.csv', 'h', 'transient', true);
    expect(store.get('b.csv')!.retry_count).toBe(1);
    expect(isReadyForRetry(store.get('b.csv')!)).toBe(false); // within the backoff window

    store.markError('b.csv', 'h', 'transient again', true);
    expect(store.get('b.csv')!.retry_count).toBe(2);
  });

  it('resets to ok when a previously-failed file finally parses', () => {
    store.markError('b.csv', 'h', 'bad', true);
    store.markOk('b.csv', 'h', 2);
    const row = store.get('b.csv')!;
    expect(row.status).toBe('ok');
    expect(row.retry_count).toBe(0);
    expect(row.last_error).toBeNull();
  });

  it('forgets a file so the next scan reads it again', () => {
    store.markOk('a.csv', 'h', 1);
    store.forget('a.csv');
    expect(store.get('a.csv')).toBeUndefined();
  });
});
