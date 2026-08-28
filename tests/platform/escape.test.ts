import { describe, it, expect } from 'vitest';
import { escapeHtml, escapeXml } from '../../server/platform/escape.js';

/**
 * One escaper, replacing the three that had drifted (`hcv-soap.ts`,
 * `routes/google.ts`, `routes/wave-oauth.ts`). The single intended
 * difference: `'` becomes `&#39;` for HTML (portable) and `&apos;` for
 * XML (valid there, not in HTML 4).
 */
describe('escape', () => {
  it('escapes the five markup-significant characters for HTML', () => {
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('uses &apos; for the apostrophe in XML', () => {
    expect(escapeXml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;');
  });

  it('leaves ordinary text untouched', () => {
    expect(escapeHtml('Google connected. Close this tab.')).toBe(
      'Google connected. Close this tab.',
    );
  });

  it('neutralises an injected script tag', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });
});
