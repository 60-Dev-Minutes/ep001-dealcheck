// Small browser helpers: storage, random keys, formatting and link safety.

export const STORAGE_MARKET = 'dealcheck.market';
export const STORAGE_JOB = 'dealcheck.job';
export const STORAGE_SUBSCRIBE = 'dealcheck.subscribe_clicked';
export const PUBLICATION_URL = 'https://60devminutes.substack.com/';
export const SUBSCRIBE_URL = 'https://60devminutes.substack.com/subscribe';
export const SUBSCRIBE_EMBED_URL = 'https://60devminutes.substack.com/embed';

export const storage = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* storage unavailable (private mode, blocked) — non-fatal */
    }
  },
  remove(key: string): void {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};

export const JOB_ID_RE = /^inv_[A-Za-z0-9_-]{20,40}$/;

const URL_SAFE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Random URL-safe string (64-symbol alphabet, so `byte & 63` is unbiased). */
export function randomKey(length = 32): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += URL_SAFE[b & 63];
  return out;
}

/** Only ever link to http(s) URLs taken from API data. */
export function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : null;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ dates

const DAY_FMT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const MONTH_FMT = new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
const LOCAL_DT_FMT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const LOCAL_TIME_FMT = new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: '2-digit' });

/** Days since epoch for a YYYY-MM-DD calendar date (UTC-anchored, no timezone drift). */
export function dayNumber(isoDate: string): number {
  return Math.floor(Date.parse(isoDate.slice(0, 10) + 'T00:00:00Z') / 86_400_000);
}

export function fromDayNumber(day: number): Date {
  return new Date(day * 86_400_000);
}

/** "2025-11-28" → "28 Nov 2025". Calendar date, not shifted into the viewer's timezone. */
export function formatDate(isoDate: string): string {
  const t = Date.parse(isoDate.slice(0, 10) + 'T00:00:00Z');
  return Number.isNaN(t) ? isoDate : DAY_FMT.format(t);
}

/** "2025-12" → "Dec 2025". */
export function formatMonth(ym: string): string {
  const t = Date.parse(ym.slice(0, 7) + '-01T00:00:00Z');
  return Number.isNaN(t) ? ym : MONTH_FMT.format(t);
}

export function formatDateRange(start: string, end: string): string {
  return start === end ? formatDate(start) : `${formatDate(start)} – ${formatDate(end)}`;
}

/** Comparison dates may be "YYYY-MM-DD" or "start/end". */
export function formatComparisonDate(d: string): string {
  const [a, b] = d.split('/');
  return b ? formatDateRange(a ?? d, b) : formatDate(d);
}

/** An instant shown in the viewer's own timezone. */
export function formatLocalDateTime(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : LOCAL_DT_FMT.format(t);
}

export function formatLocalTime(iso: string): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : LOCAL_TIME_FMT.format(t);
}

/** A market-local wall-clock stamp such as "2026-11-30T23:59" — shown as written, no conversion. */
export function formatWallClock(s: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(s);
  if (!m || !m[1]) return s;
  return m[2] ? `${formatDate(m[1])}, ${m[2]}` : formatDate(m[1]);
}

// ------------------------------------------------------------------ numbers

const PCT_FMT = new Intl.NumberFormat('en-NZ', { minimumFractionDigits: 0, maximumFractionDigits: 1 });

export function formatPercentAbs(p: number): string {
  return `${PCT_FMT.format(Math.abs(p))}%`;
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'unknown';
  const s = Math.round(ms / 100) / 10;
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s - m * 60)} s`;
}
