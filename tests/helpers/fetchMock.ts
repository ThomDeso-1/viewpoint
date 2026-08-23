import { vi } from 'vitest';

/** Installs a mock for global fetch and returns the mock fn to configure per-test. */
export function installFetchMock() {
  const mock = vi.fn();
  vi.stubGlobal('fetch', mock);
  return mock;
}

/** Builds a minimal fetch Response-like object for a JSON body. */
export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: {
      get: (key: string) => headers[key] ?? headers[key.toLowerCase()] ?? null,
    },
    json: async () => body,
  } as unknown as Response;
}

/** A fetch implementation that always rejects, simulating a network failure. */
export function networkFailure(message = 'getaddrinfo ENOTFOUND'): () => Promise<never> {
  return () => Promise.reject(new Error(message));
}
