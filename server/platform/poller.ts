/**
 * Background-poller scaffolding, shared by the receipt upload queue and
 * the exams queue (audit P2-27).
 *
 * Both queues had their own copy of: a re-entry guard, a `setInterval`
 * handle, a fire-and-forget trigger that logs but never rejects, and
 * `start`/`stop`. Only the `pass()` they run and the log prefix differed.
 *
 * The re-entry guard means a slow pass never overlaps the next tick — a
 * pass already in flight makes `trigger()` (and the interval) a no-op
 * until it settles. Backoff is still stored per row (`backoff.ts`), so a
 * skipped tick costs nothing.
 *
 * Pollers are started only from `server/index.ts`, never `createApp()`,
 * so tests don't spawn timers.
 */

export interface PollerOptions {
  /** Log prefix, e.g. `upload-queue` / `exams-queue`. */
  name: string;
  intervalMs: number;
  /** One pass over the queue. Rejections are caught and logged. */
  pass: () => Promise<void>;
}

export interface Poller {
  /** Run a pass now, fire-and-forget. No-op while one is already running. */
  trigger: () => void;
  /** Start the interval, running one pass immediately. Idempotent. */
  start: () => void;
  /** Stop the interval. An in-flight pass finishes on its own. */
  stop: () => void;
}

export function makePoller(options: PollerOptions): Poller {
  let running = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  async function runOnce(): Promise<void> {
    if (running) return;
    running = true;
    try {
      await options.pass();
    } finally {
      running = false;
    }
  }

  function trigger(): void {
    runOnce().catch((err) => {
      console.error(`[${options.name}] pass failed:`, err);
    });
  }

  function start(): void {
    if (timer) return;
    timer = setInterval(trigger, options.intervalMs);
    trigger();
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { trigger, start, stop };
}
