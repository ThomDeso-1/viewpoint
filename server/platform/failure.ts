/**
 * The "record a failed attempt" state transition, shared by the three
 * retry loops that each hand-rolled it (audit P3-28): exam-request
 * extraction / drafting (`exams/exam-requests.ts`), reminder dispatch
 * (`exams/reminders.ts`), and the receipt upload queue
 * (`receipts/upload-queue.ts`).
 *
 * The shape is always "retryable? bump the count; count hit the ceiling?
 * give up". The three differ only in policy:
 *   - `retrying` — the status a row keeps while it still has attempts left
 *     (`reviewed` / `pending` / or the exam request's current status)
 *   - `terminal` — what a *non*-retryable error means: `failed`, or
 *     `needsAttention` to park it for the operator. Defaults to
 *     `exhausted`.
 *   - `countAlways` — whether a non-retryable attempt still counts against
 *     the budget. The receipt queue increments regardless; the exams
 *     loops only count retryable attempts.
 *
 * This computes the transition; the caller owns the UPDATE (and the
 * `last_error` / `updated_at` columns, which are uniform).
 */

import { DEFAULT_MAX_RETRIES } from './backoff.js';

export interface FailurePolicy<S extends string> {
  /** Status kept while retries remain. */
  retrying: S;
  /** Status once the retry budget is spent. */
  exhausted: S;
  /** Status for a non-retryable error. Defaults to `exhausted`. */
  terminal?: S;
  maxRetries?: number;
  /** Count this attempt even when it is not retryable. */
  countAlways?: boolean;
}

export function applyFailure<S extends string>(
  row: { retry_count: number },
  retryable: boolean,
  policy: FailurePolicy<S>,
): { status: S; retryCount: number } {
  const maxRetries = policy.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryCount =
    retryable || policy.countAlways ? row.retry_count + 1 : row.retry_count;

  const status = !retryable
    ? (policy.terminal ?? policy.exhausted)
    : retryCount >= maxRetries
      ? policy.exhausted
      : policy.retrying;

  return { status, retryCount };
}
