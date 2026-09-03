import { getAccessToken, MicrosoftAuthError } from './auth.js';
import { endpoint } from '../../platform/endpoints.js';

/**
 * The shared Microsoft Graph fetch wrapper.
 *
 * One place for the access-header, the 30s timeout, and the status
 * taxonomy every Graph call needs: 401 is a broken connection (not a
 * blip), 429 / 5xx are retryable server errors, anything else non-2xx is
 * a bad request. `sendMail` (graph.ts) and the calendar client
 * (calendar.ts) both go through this.
 *
 * `allow` lets a caller opt a status out of the taxonomy and handle it as
 * control flow instead — the calendar client uses it for `412` (ETag
 * precondition failed), `410` (delta token expired) and `404`.
 */

export interface GraphFetchOptions {
  /** Status codes to return to the caller unthrown, e.g. `[404, 410, 412]`. */
  allow?: number[];
}

export async function graphFetch(
  path: string,
  init: RequestInit = {},
  opts: GraphFetchOptions = {},
): Promise<Response> {
  const token = await getAccessToken();

  // A delta / nextLink is an absolute Graph URL; a plain path is relative
  // to the (possibly redirected, in demo mode) base.
  const url = path.startsWith('http') ? rebaseAbsolute(path) : `${endpoint('graphBase')}${path}`;

  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new MicrosoftAuthError('network_error', `Network error: ${(err as Error).message}`);
  }

  if (opts.allow?.includes(res.status)) return res;

  if (res.status === 401) {
    throw new MicrosoftAuthError(
      'not_connected',
      'Microsoft rejected the stored credentials. Reconnect in Settings.',
    );
  }

  if (res.status === 429 || res.status >= 500) {
    throw new MicrosoftAuthError('server_error', `Graph API error (${res.status}): ${res.statusText}`);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new MicrosoftAuthError('bad_request', `Graph API error (${res.status}): ${detail}`);
  }

  return res;
}

/** `graphFetch` plus JSON parsing, for the common read case. */
export async function graphJson<T = any>(
  path: string,
  init: RequestInit = {},
  opts: GraphFetchOptions = {},
): Promise<T> {
  const res = await graphFetch(path, init, opts);
  return res.json() as Promise<T>;
}

/**
 * An `@odata.nextLink` / `@odata.deltaLink` comes back pointing at the
 * real `graph.microsoft.com` host. In demo mode the base is the local
 * mock, so swap the origin + version prefix back to whatever `graphBase`
 * currently resolves to and keep the path + query.
 */
function rebaseAbsolute(absolute: string): string {
  const base = endpoint('graphBase');
  if (absolute.startsWith(base)) return absolute;

  const marker = '/v1.0';
  const idx = absolute.indexOf(marker);
  if (idx === -1) return absolute;
  return base + absolute.slice(idx + marker.length);
}
