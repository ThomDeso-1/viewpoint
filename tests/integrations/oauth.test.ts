import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  issueState,
  consumeState,
  resetPendingStates,
} from '../../server/integrations/oauth/state-store.js';
import { makeCallbackRouter } from '../../server/integrations/oauth/callback.js';

/**
 * The pieces the Google, Wave and Microsoft OAuth flows now share (audit
 * P2-25). The full flows are still exercised end to end in google.test.ts,
 * microsoft.test.ts and wave-oauth.test.ts; this covers the extracted seam
 * directly.
 */

describe('oauth state store', () => {
  beforeEach(() => resetPendingStates());

  it('issues a state that consumes exactly once', () => {
    const state = issueState();
    expect(consumeState(state)).toBeTruthy();
    expect(consumeState(state)).toBeNull();
  });

  it('rejects a state it never issued, and undefined', () => {
    expect(consumeState('never-seen')).toBeNull();
    expect(consumeState(undefined)).toBeNull();
  });

  it('keeps issued states independent', () => {
    const a = issueState();
    const b = issueState();
    expect(consumeState(b)).toBeTruthy();
    expect(consumeState(a)).toBeTruthy();
  });

  it('round-trips the PKCE verifier stashed with a state', () => {
    const state = issueState({ verifier: 'the-verifier' });
    expect(consumeState(state)).toEqual({ verifier: 'the-verifier' });
  });

  it('returns an empty object for a state issued without data', () => {
    expect(consumeState(issueState())).toEqual({});
  });
});

describe('makeCallbackRouter', () => {
  function appFor(provider: Parameters<typeof makeCallbackRouter>[0]) {
    const app = express();
    app.use('/cb', makeCallbackRouter(provider));
    return app;
  }

  const okProvider = {
    name: 'Testly',
    exchange: async () => {},
    describeError: (err: unknown) => (err as Error).message,
  };

  beforeEach(() => resetPendingStates());

  it('rejects a forged state before ever calling exchange', async () => {
    let called = false;
    const app = appFor({ ...okProvider, exchange: async () => void (called = true) });

    const res = await request(app).get('/cb/callback?code=x&state=forged');
    expect(res.status).toBe(400);
    expect(res.text).toContain('expired or was already used');
    expect(called).toBe(false);
  });

  it('surfaces a provider-side denial with the provider name', async () => {
    const res = await request(appFor(okProvider)).get('/cb/callback?error=access_denied&state=x');
    expect(res.status).toBe(400);
    expect(res.text).toContain('Testly returned an error: access_denied');
  });

  it('exchanges a good code and reports success', async () => {
    const app = appFor(okProvider);
    const state = issueState();

    const res = await request(app).get(`/cb/callback?code=the-code&state=${state}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Testly connected');
  });

  it('reports a failed exchange as a 502 without claiming success', async () => {
    const app = appFor({
      ...okProvider,
      exchange: async () => {
        throw new Error('token endpoint said no');
      },
    });
    const state = issueState();

    const res = await request(app).get(`/cb/callback?code=bad&state=${state}`);
    expect(res.status).toBe(502);
    expect(res.text).toContain('Connection failed');
    expect(res.text).toContain('token endpoint said no');
  });

  it('escapes a message from the provider into the result page', async () => {
    const app = appFor({
      ...okProvider,
      exchange: async () => {
        throw new Error('<img src=x onerror=alert(1)>');
      },
    });
    const state = issueState();

    const res = await request(app).get(`/cb/callback?code=bad&state=${state}`);
    expect(res.text).not.toContain('<img src=x');
    expect(res.text).toContain('&lt;img src=x');
  });
});
