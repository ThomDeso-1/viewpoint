import { describe, it, expect, vi, afterEach } from 'vitest';
import { makePoller } from '../../server/platform/poller.js';

/**
 * The poll loop the receipt upload queue and the practice queue now
 * share (audit P2-27): re-entry guard, interval, fire-and-forget trigger
 * that logs but never rejects.
 */
describe('makePoller', () => {
  afterEach(() => vi.useRealTimers());

  it('start runs a pass immediately, then once per interval, until stop', async () => {
    vi.useFakeTimers();
    const pass = vi.fn().mockResolvedValue(undefined);
    const poller = makePoller({ name: 'test', intervalMs: 1000, pass });

    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(pass).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(pass).toHaveBeenCalledTimes(2);

    poller.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(pass).toHaveBeenCalledTimes(2);
  });

  it('start is idempotent — a second call does not add an interval', async () => {
    vi.useFakeTimers();
    const pass = vi.fn().mockResolvedValue(undefined);
    const poller = makePoller({ name: 'test', intervalMs: 1000, pass });

    poller.start();
    poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(pass).toHaveBeenCalledTimes(1); // one immediate run, not two

    await vi.advanceTimersByTimeAsync(1000);
    expect(pass).toHaveBeenCalledTimes(2); // one tick, not two
    poller.stop();
  });

  it('does not start a second pass while one is still running', async () => {
    let resolve!: () => void;
    const pass = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    const poller = makePoller({ name: 'test', intervalMs: 1000, pass });

    poller.trigger();
    poller.trigger();
    expect(pass).toHaveBeenCalledTimes(1);

    resolve();
    await Promise.resolve();
    poller.trigger();
    expect(pass).toHaveBeenCalledTimes(2);
  });

  it('swallows and logs a rejected pass rather than throwing', async () => {
    const err = new Error('pass blew up');
    const pass = vi.fn().mockRejectedValue(err);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const poller = makePoller({ name: 'widgets', intervalMs: 1000, pass });

    expect(() => poller.trigger()).not.toThrow();
    await new Promise((r) => setImmediate(r));

    expect(spy).toHaveBeenCalledWith('[widgets] pass failed:', err);
    spy.mockRestore();
  });
});
