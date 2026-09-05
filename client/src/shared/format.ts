/**
 * Parses an ISO datetime string, returning `null` (not `NaN`) on failure
 * so callers can fall back cleanly instead of rendering "Invalid Date".
 */
export function parseIsoDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

const LOCALE = 'en-CA';

/** "5 Sep 2026", or a dash for a missing/unparseable date. */
export function formatDate(iso: string | null | undefined): string {
  const d = parseIsoDate(iso);
  if (!d) return '—';
  return d.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** "Fri 5 Sep, 2:14 PM", or a dash. Drops the year unless it differs from now. */
export function formatDateTime(iso: string | null | undefined): string {
  const d = parseIsoDate(iso);
  if (!d) return '—';
  const opts: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return d.toLocaleString(LOCALE, opts);
}

/** "Fri 5 Sep · 2:00 – 2:30 PM", collapsing to a single time when there's no end. */
export function formatDateRange(
  startIso: string | null | undefined,
  endIso: string | null | undefined,
): string {
  const start = parseIsoDate(startIso);
  if (!start) return '—';
  const day = start.toLocaleDateString(LOCALE, { weekday: 'short', day: 'numeric', month: 'short' });
  const t = (d: Date) => d.toLocaleTimeString(LOCALE, { hour: 'numeric', minute: '2-digit' });
  const end = parseIsoDate(endIso);
  return end ? `${day} · ${t(start)} – ${t(end)}` : `${day} · ${t(start)}`;
}

/** "$120.00" — currency formatting, tolerant of null. */
export function formatMoney(
  amount: number | null | undefined,
  currency = 'CAD',
): string {
  if (amount == null || Number.isNaN(amount)) return '—';
  return new Intl.NumberFormat(LOCALE, { style: 'currency', currency: currency || 'CAD' }).format(amount);
}

/** "just now" / "3 min ago" / "2 h ago" / "in 4 days". */
export function formatRelative(iso: string | null | undefined): string {
  const d = parseIsoDate(iso);
  if (!d) return '—';
  const diffMs = d.getTime() - Date.now();
  const past = diffMs <= 0;
  const mins = Math.round(Math.abs(diffMs) / 60_000);
  if (mins < 1) return 'just now';
  const say = (n: number, unit: string) =>
    past ? `${n} ${unit}${n === 1 ? '' : 's'} ago` : `in ${n} ${unit}${n === 1 ? '' : 's'}`;
  if (mins < 60) return say(mins, past ? 'min' : 'minute').replace('mins', 'min');
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return say(hrs, 'h').replace(/\bhs\b/, 'h');
  const days = Math.round(hrs / 24);
  return say(days, 'day');
}

/** First `keep` characters of an id, for compact display of a UUID. */
export function maskId(id: string | null | undefined, keep = 8): string {
  if (!id) return '';
  return id.length > keep ? id.slice(0, keep) : id;
}

/** "2026-09" → "September 2026". */
export function formatMonthFolder(folder: string): string {
  const [year, month] = folder.split('-');
  const d = new Date(Number(year), Number(month) - 1);
  return Number.isNaN(d.getTime())
    ? folder
    : d.toLocaleDateString(LOCALE, { year: 'numeric', month: 'long' });
}
