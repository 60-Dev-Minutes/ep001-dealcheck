import { ALL_CURRENCY_TOKENS, currencySymbols, decimalConvention, type Market } from './markets';

export const MAX_AMOUNT_MINOR = 10_000_000_00; // 10 million major units

export type PriceParse =
  | { kind: 'ok'; minor: number }
  | { kind: 'empty' }
  | { kind: 'invalid'; reason: string }
  | { kind: 'ambiguous'; reason: string; options: number[] }
  | { kind: 'currency_mismatch'; reason: string };

const GROUP_SEPARATORS = /[\s   ']/g;

/**
 * Parse a user-entered price in the selected market's currency into integer minor units.
 * Never guesses: unclear notation returns `ambiguous` with the candidate readings.
 */
export function parseUserPrice(raw: string, market: Market): PriceParse {
  let s = raw.trim();
  if (s === '') return { kind: 'empty' };
  if (s.length > 32) return { kind: 'invalid', reason: 'Price is too long.' };

  // Currency token handling: allowed tokens for this market are stripped; foreign tokens are a mismatch.
  const allowed = currencySymbols(market.currency);
  for (const token of ALL_CURRENCY_TOKENS) {
    const idx = s.toUpperCase().indexOf(token.toUpperCase());
    if (idx === -1) continue;
    if (!allowed.some((a) => a.toUpperCase() === token.toUpperCase())) {
      return { kind: 'currency_mismatch', reason: `The price uses ${token}, but the ${market.name} market uses ${market.currency}.` };
    }
    s = (s.slice(0, idx) + s.slice(idx + token.length)).trim();
  }
  s = s.replace(/[.,]-$/, ''); // "799.-" / "799,-" means whole amount
  s = s.replace(GROUP_SEPARATORS, (m, offset: number) => (/\d/.test(s[offset - 1] ?? '') ? '' : m));
  if (s.startsWith('-')) return { kind: 'invalid', reason: 'Price must be positive.' };
  if (!/^\d[\d.,]*$/.test(s)) return { kind: 'invalid', reason: 'Enter a number such as 799 or 799.99.' };

  const conv = decimalConvention(market);
  const dots = (s.match(/\./g) ?? []).length;
  const commas = (s.match(/,/g) ?? []).length;

  let minor: number | null = null;
  if (dots === 0 && commas === 0) {
    minor = toMinor(s, '');
  } else if (dots > 0 && commas > 0) {
    const lastDot = s.lastIndexOf('.');
    const lastComma = s.lastIndexOf(',');
    const dec = lastDot > lastComma ? '.' : ',';
    const grp = dec === '.' ? ',' : '.';
    if ((s.match(new RegExp(`\\${dec}`, 'g')) ?? []).length !== 1) return { kind: 'invalid', reason: 'Unrecognised number format.' };
    const [intPart, frac] = s.split(dec) as [string, string];
    if (!validGroups(intPart, grp)) return { kind: 'invalid', reason: 'Unrecognised digit grouping.' };
    if (frac.length < 1 || frac.length > 2) return { kind: 'invalid', reason: 'Use at most two decimal places.' };
    minor = toMinor(intPart.split(grp).join(''), frac);
  } else {
    const sep = dots > 0 ? '.' : ',';
    const count = dots + commas;
    const parts = s.split(sep);
    if (count > 1) {
      // Repeated separator can only be digit grouping.
      if (!validGroups(s, sep)) return { kind: 'invalid', reason: 'Unrecognised digit grouping.' };
      minor = toMinor(parts.join(''), '');
    } else {
      const [intPart, frac] = parts as [string, string];
      if (intPart === '') return { kind: 'invalid', reason: 'Enter a number such as 799 or 799.99.' };
      if (frac.length === 1 || frac.length === 2) {
        // One or two digits after a single separator can only be decimals, in either convention.
        minor = toMinor(intPart, frac);
      } else if (frac.length === 3) {
        const localGroup = conv === 'dot' ? ',' : '.';
        const asThousands = toMinor(intPart + frac, '');
        if (asThousands === null) return { kind: 'invalid', reason: 'Unrecognised number format.' };
        if (sep === localGroup && intPart.length <= 3) {
          minor = asThousands;
        } else {
          const asDecimal = Number(intPart) * 100 + Math.round(Number(frac) / 10);
          return {
            kind: 'ambiguous',
            reason: `"${raw.trim()}" could mean ${format(asThousands)} or about ${format(asDecimal)}. Please re-enter the price without ambiguity.`,
            options: [asThousands],
          };
        }
      } else {
        return { kind: 'invalid', reason: 'Use at most two decimal places.' };
      }
    }
  }
  if (minor === null || !Number.isSafeInteger(minor)) return { kind: 'invalid', reason: 'Unrecognised number format.' };
  if (minor <= 0) return { kind: 'invalid', reason: 'Price must be greater than zero.' };
  if (minor > MAX_AMOUNT_MINOR) return { kind: 'invalid', reason: 'Price is unrealistically large.' };
  return { kind: 'ok', minor };
}

function validGroups(s: string, sep: string): boolean {
  const parts = s.split(sep);
  if (parts.length < 2) return /^\d+$/.test(s);
  const [first, ...rest] = parts as [string, ...string[]];
  return /^\d{1,3}$/.test(first) && rest.every((p) => /^\d{3}$/.test(p));
}

function toMinor(intPart: string, frac: string): number | null {
  if (!/^\d+$/.test(intPart) || (frac !== '' && !/^\d{1,2}$/.test(frac))) return null;
  const f = frac.padEnd(2, '0');
  return Number(intPart) * 100 + Number(f || '0');
}

function format(minor: number): string {
  return (minor / 100).toFixed(2);
}

/** Format integer minor units for display with the currency code. Display only — never used for arithmetic. */
export function formatMoney(minor: number, currency: string, locale = 'en-NZ'): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const major = Math.floor(abs / 100);
  const cents = String(abs % 100).padStart(2, '0');
  const grouped = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(major);
  return `${sign}${currency} ${grouped}.${cents}`;
}

/**
 * Extract every price-like number from free text, returning all plausible minor-unit readings
 * (both decimal conventions). Used to check that an evidence excerpt literally supports an amount.
 */
export function amountsInText(text: string): Set<number> {
  const out = new Set<number>();
  const re = /\d{1,3}(?:[.,\s  ']\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?/g;
  for (const m of text.matchAll(re)) {
    const token = m[0];
    const end = (m.index ?? 0) + token.length;
    // Skip numbers that are part of longer digit/decimal runs, dates (2026-07-10), or model numbers.
    const next = text[end] ?? '';
    if (/\d/.test(next)) continue;
    const cleaned = token.replace(/[\s  ']/g, '');
    for (const reading of readings(cleaned)) out.add(reading);
    // "799.-" / "799,-"
    if (/^[.,]-/.test(text.slice(end))) {
      const v = Number(cleaned.replace(/[.,]/g, ''));
      if (Number.isSafeInteger(v)) out.add(v * 100);
    }
  }
  return out;
}

function readings(s: string): number[] {
  const res: number[] = [];
  for (const [dec, grp] of [['.', ','], [',', '.']] as const) {
    const parts = s.split(dec);
    if (parts.length > 2) continue;
    const intRaw = parts[0] ?? '';
    const frac = parts[1];
    if (frac !== undefined && (frac.length < 1 || frac.length > 2)) continue;
    if (intRaw.includes(grp) && !validGroups(intRaw, grp)) continue;
    const intPart = intRaw.split(grp).join('');
    if (!/^\d+$/.test(intPart)) continue;
    const v = toMinor(intPart, frac ?? '');
    if (v !== null) res.push(v);
  }
  return res;
}
