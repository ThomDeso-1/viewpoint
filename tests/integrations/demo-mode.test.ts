import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { setupTestApp, type TestContext } from '../helpers/testApp.js';

/**
 * Demo mode redirects every outbound call to a local mock server.
 *
 * The safety property that matters: it must be **off unless explicitly
 * asked for**, and impossible to enable one service at a time — otherwise
 * a stray variable could quietly send patient data somewhere unintended.
 */
describe('demo mode', () => {
  let endpoints: typeof import('../../server/platform/endpoints.js');

  beforeEach(async () => {
    delete process.env.DEMO_MODE;
    delete process.env.DEMO_API_BASE;
    endpoints = await import('../../server/platform/endpoints.js');
  });

  afterEach(() => {
    delete process.env.DEMO_MODE;
    delete process.env.DEMO_API_BASE;
  });

  const ALL = [
    'anthropicMessages',
    'waveGraphql',
    'waveAuthorize',
    'waveToken',
    'googleAuthorize',
    'googleToken',
    'googleUserinfo',
    'gmailBase',
    'calendarBase',
    'microsoftAuthorize',
    'microsoftToken',
    'graphBase',
  ] as const;

  it('is off by default', () => {
    expect(endpoints.isDemoMode()).toBe(false);
  });

  it('points at the real providers when off', () => {
    for (const name of ALL) {
      const url = endpoints.endpoint(name);
      expect(url.startsWith('https://')).toBe(true);
      expect(url).not.toContain('localhost');
    }

    expect(endpoints.endpoint('anthropicMessages')).toBe('https://api.anthropic.com/v1/messages');
    expect(endpoints.endpoint('waveGraphql')).toBe('https://gql.waveapps.com/graphql/public');
    expect(endpoints.endpoint('gmailBase')).toContain('gmail.googleapis.com');
  });

  it('redirects every endpoint when on — none left pointing outward', () => {
    process.env.DEMO_MODE = '1';

    for (const name of ALL) {
      expect(endpoints.endpoint(name)).toContain('localhost:4000');
    }
  });

  it('accepts a custom mock base', () => {
    process.env.DEMO_MODE = '1';
    process.env.DEMO_API_BASE = 'http://127.0.0.1:9999';

    expect(endpoints.endpoint('waveGraphql')).toBe('http://127.0.0.1:9999/wave/graphql');
  });

  it('tolerates a trailing slash on the base', () => {
    process.env.DEMO_MODE = '1';
    process.env.DEMO_API_BASE = 'http://localhost:4000/';

    expect(endpoints.endpoint('gmailBase')).toBe('http://localhost:4000/gmail/v1/users/me');
  });

  it.each([['0'], ['false'], [''], ['yes'], ['on']])(
    'stays off for DEMO_MODE=%j — only an explicit 1/true enables it',
    (value) => {
      process.env.DEMO_MODE = value;
      expect(endpoints.isDemoMode()).toBe(false);
    },
  );

  it.each([['1'], ['true']])('turns on for DEMO_MODE=%j', (value) => {
    process.env.DEMO_MODE = value;
    expect(endpoints.isDemoMode()).toBe(true);
  });

  it('resolves per call, so it can be toggled after the module loads', () => {
    expect(endpoints.endpoint('waveGraphql')).toContain('waveapps.com');
    process.env.DEMO_MODE = '1';
    expect(endpoints.endpoint('waveGraphql')).toContain('localhost');
  });
});

describe('demo mode is visible to the UI', () => {
  let ctx: TestContext;
  afterEach(() => {
    delete process.env.DEMO_MODE;
    ctx?.teardown();
  });

  it('is reported as false in a normal install', async () => {
    ctx = await setupTestApp();
    const res = await request(ctx.app).get('/api/settings');
    expect(res.body.demoMode).toBe(false);
  });

  it('is reported as true so the app can warn', async () => {
    ctx = await setupTestApp({ DEMO_MODE: '1' });
    const res = await request(ctx.app).get('/api/settings');
    expect(res.body.demoMode).toBe(true);
  });
});
