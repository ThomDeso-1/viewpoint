/**
 * Retry pacing, shared by the receipt upload queue and the practice
 * queue.
 *
 * Both queues store their backoff rather than sleeping it: a row that
 * failed records when it was last touched and how many attempts it has
 * had, and each pass skips the rows that are not due yet. One flaky item
 * therefore never blocks the rest of the batch, and a restart resumes the
 * schedule instead of resetting it.
 */

export const DEFAULT_BASE_DELAY_MS = 5_000;
export const DEFAULT_MAX_DELAY_MS = 300_000;
export const DEFAULT_MAX_RETRIES = 5;

export interface BackoffOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/** Exponential delay for the Nth retry, capped. Zero for a first attempt. */
export function backoffDelayMs(retryCount: number, options: BackoffOptions = {}): number {
  if (retryCount <= 0) return 0;

  const base = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const max = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;

  return Math.min(base * Math.pow(2, retryCount - 1), max);
}

/**
 * Whether a previously-failed row is due for another attempt.
 *
 * `updatedAt` is the row's own timestamp column, so the schedule survives
 * a process restart.
 */
export function isReadyForRetry(
  row: { retry_count: number; updated_at: string },
  now: number = Date.now(),
  options: BackoffOptions = {},
): boolean {
  if (row.retry_count <= 0) return true;

  const readyAt = new Date(row.updated_at).getTime() + backoffDelayMs(row.retry_count, options);

  // An unparseable timestamp would otherwise make readyAt NaN, and every
  // comparison against NaN is false — permanently stranding the row.
  if (Number.isNaN(readyAt)) return true;

  return now >= readyAt;
}

/** True once a row has used up its attempts. */
export function isExhausted(retryCount: number, maxRetries: number = DEFAULT_MAX_RETRIES): boolean {
  return retryCount >= maxRetries;
}
