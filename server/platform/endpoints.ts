/**
 * Where the app's outbound calls go.
 *
 * Normally these are the real providers. In **demo mode** they all point
 * at a single local mock server (`demo/mock-server.ts`) instead, so the
 * whole workflow can be exercised — and its bugs found — without any
 * credentials, any spending, and without a byte leaving the machine.
 *
 * The client code itself is unchanged either way: the same GraphQL
 * parsing, MIME decoding, OAuth exchange, retry and error-taxonomy paths
 * run in demo mode as in production. That is the point — a mock that
 * bypassed those would not find the bugs that live in them.
 *
 * Demo mode is deliberately a single explicit switch rather than a
 * per-endpoint override, so there is exactly one thing to audit, and
 * nothing can be quietly redirected one service at a time.
 */

const REAL = {
  anthropicMessages: 'https://api.anthropic.com/v1/messages',
  waveGraphql: 'https://gql.waveapps.com/graphql/public',
  waveAuthorize: 'https://api.waveapps.com/oauth2/authorize',
  waveToken: 'https://api.waveapps.com/oauth2/token/',
  microsoftAuthorize: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize',
  microsoftToken: 'https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token',
  graphBase: 'https://graph.microsoft.com/v1.0',
} as const;

export type EndpointName = keyof typeof REAL;

export function isDemoMode(): boolean {
  const value = process.env.DEMO_MODE;
  return value === '1' || value === 'true';
}

function demoBase(): string {
  return (process.env.DEMO_API_BASE || 'http://localhost:4000').replace(/\/$/, '');
}

const DEMO_PATHS: Record<EndpointName, string> = {
  anthropicMessages: '/anthropic/v1/messages',
  waveGraphql: '/wave/graphql',
  waveAuthorize: '/wave/oauth/authorize',
  waveToken: '/wave/oauth/token',
  microsoftAuthorize: '/microsoft/oauth/authorize',
  microsoftToken: '/microsoft/oauth/token',
  graphBase: '/graph/v1.0',
};

/**
 * Resolved at call time, not module load, so tests and the demo runner
 * can set DEMO_MODE after the module graph is already built.
 */
export function endpoint(name: EndpointName): string {
  return isDemoMode() ? demoBase() + DEMO_PATHS[name] : REAL[name];
}

/** One loud line at startup — demo mode must never be mistaken for real. */
export function warnIfDemoMode(): void {
  if (!isDemoMode()) return;

  console.warn('');
  console.warn('  ┌─────────────────────────────────────────────────────────┐');
  console.warn('  │  DEMO MODE — no real services are being contacted.      │');
  console.warn('  │                                                         │');
  console.warn('  │  Claude, Wave and Microsoft Graph all point at the      │');
  console.warn(`  │  local mock server at ${demoBase().padEnd(34)}│`);
  console.warn('  │  Invoices, emails and extractions are all fabricated.   │');
  console.warn('  └─────────────────────────────────────────────────────────┘');
  console.warn('');
}
