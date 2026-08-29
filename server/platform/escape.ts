/**
 * Entity escaping for the handful of places this server emits markup
 * itself: the OAuth result page (HTML) and the HCV SOAP request (XML).
 *
 * Previously written out three times — `escapeXml` in `hcv-soap.ts` and a
 * near-identical HTML escaper inlined in each of the two OAuth route
 * files — with one difference that mattered: `'` → `&apos;` is valid in
 * XML but not in HTML 4, so the HTML variant uses the numeric `&#39;`,
 * which every parser accepts.
 */

const BASE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
};

const HTML_MAP: Record<string, string> = { ...BASE, "'": '&#39;' };
const XML_MAP: Record<string, string> = { ...BASE, "'": '&apos;' };

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_MAP[c]);
}

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => XML_MAP[c]);
}
