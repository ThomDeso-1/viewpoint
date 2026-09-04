/**
 * Parses an ISO datetime string, returning `null` (not `NaN`) on failure
 * so callers can fall back cleanly instead of rendering "Invalid Date".
 */
export function parseIsoDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}
