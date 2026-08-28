/**
 * Wave GraphQL transport — the one HTTP path every other wave/ module
 * goes through, plus the error taxonomy the queues read.
 *
 * Split out of the old 691-line `wave.ts` (audit P2-26). Siblings
 * (`reference`, `expenses`, `customers`, `invoices`) import `makeRequest`
 * and `collectInputErrors` from here; nothing here imports them back.
 */

import { endpoint } from '../../platform/endpoints.js';

export class WaveAPIError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'WaveAPIError';
    this.code = code;
  }

  get isRetryable(): boolean {
    return this.code === 'network_error' || this.code === 'server_error';
  }
}

export async function makeRequest(
  query: string,
  variables: Record<string, any>,
  token: string,
): Promise<Record<string, any>> {
  let res: Response;

  try {
    res = await fetch(endpoint('waveGraphql'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw new WaveAPIError('network_error', `Network error: ${(err as Error).message}`);
  }

  if (res.status === 401) {
    throw new WaveAPIError('token_expired', 'Your Wave access token has expired.');
  }

  if (res.status !== 200) {
    throw new WaveAPIError(
      'server_error',
      `Wave API error (${res.status}): ${res.statusText}`,
    );
  }

  const json = (await res.json()) as any;

  if (json.errors) {
    const messages: string[] = json.errors.map((e: any) => e.message || 'Unknown error');
    if (messages.some((m) => m.toLowerCase().includes('unauthorized'))) {
      throw new WaveAPIError('invalid_token', 'Your Wave access token is invalid.');
    }
    throw new WaveAPIError('graphql_errors', `Wave error: ${messages.join('; ')}`);
  }

  if (!json.data) {
    throw new WaveAPIError('invalid_response', 'Wave returned an unexpected response.');
  }

  return json.data;
}

/** Flattens Wave's `inputErrors` into `path: message` strings. */
export function collectInputErrors(result: any): string[] {
  return (result?.inputErrors ?? []).map((e: any) => {
    const p = e.path || '';
    const m = e.message || 'Unknown error';
    return p ? `${p}: ${m}` : m;
  });
}
