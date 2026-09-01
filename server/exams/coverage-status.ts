/**
 * Interprets the free-text "Status" / "OHIP status" column that clinic
 * schedule files carry into a small set of classes the UI can colour.
 *
 * This is deliberately conservative. The values are written by hand and
 * vary wildly ("Ok", "Not eligible", "$180 private pay", bare codes like
 * "407", dates like "Elig. 12/05/24"). Anything that is not an obvious
 * keyword match falls back to `unknown` and is shown neutrally with its
 * raw text — a guess here would look like a coverage decision the app
 * never actually made.
 */

export type CoverageClass = 'covered' | 'not_covered' | 'private_pay' | 'unknown';

export function classifyCoverageStatus(raw: string | null): CoverageClass {
  const text = (raw ?? '').trim().toLowerCase();
  if (!text) return 'unknown';

  // A dollar amount or an explicit private-pay note: the patient is paying,
  // regardless of whatever else the cell says.
  if (/\$\s*\d|private\s*pay|\bprivate\b|self[\s-]*pay/.test(text)) return 'private_pay';

  // Explicitly not covered. Checked before the "covered" keywords so
  // "not eligible" is not caught by "eligible".
  if (/\bnot\s*elig|ineligible|not\s*covered|\bexpired\b|no\s*ohip|\bdenied\b|\binvalid\b|lost\s*or\s*stolen/.test(text)) {
    return 'not_covered';
  }

  if (/\bok\b|elig|\bcovered\b|\bvalid\b|\bactive\b/.test(text)) return 'covered';

  return 'unknown';
}
