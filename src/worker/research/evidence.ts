// Evidence corpus extracted from provider responses, and the deterministic validator that binds
// every model-proposed observation to retrieved source text. Model output is never trusted directly.
import { z } from 'zod';
import { amountsInText, MAX_AMOUNT_MINOR } from '../../shared/money';
import { FOREIGN_CCTLDS, MARKET_TLDS, seedSources, uniqueCurrencyTokens, type Market } from '../../shared/markets';

export interface FetchedDoc {
  url: string;
  text: string; // plain text; empty when content is binary (e.g. PDF)
  binary: boolean;
  retrieved_at: string;
}

export interface EvidenceCorpus {
  searchResults: { url: string; title: string; page_age: string | null }[];
  fetched: FetchedDoc[];
  citations: { url: string; cited_text: string }[];
  toolErrors: { tool: string; code: string }[];
  queries: string[];
  /** Every provider web_fetch attempt and whether it returned content (for source access learning). */
  fetchAttempts: { url: string; ok: boolean; code: string | null }[];
}

export function emptyCorpus(): EvidenceCorpus {
  return { searchResults: [], fetched: [], citations: [], toolErrors: [], queries: [], fetchAttempts: [] };
}

export function mergeCorpus(a: EvidenceCorpus, b: EvidenceCorpus): EvidenceCorpus {
  return {
    searchResults: [...a.searchResults, ...b.searchResults],
    fetched: [...a.fetched, ...b.fetched],
    citations: [...a.citations, ...b.citations],
    toolErrors: [...a.toolErrors, ...b.toolErrors],
    queries: [...a.queries, ...b.queries],
    fetchAttempts: [...a.fetchAttempts, ...b.fetchAttempts],
  };
}

// ------------------------------------------------------------------ model output schema

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => !Number.isNaN(Date.parse(d + 'T00:00:00Z')) && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d, 'invalid date');
const httpUrl = z.string().max(2048).refine((u) => {
  try {
    const p = new URL(u);
    return p.protocol === 'https:' || p.protocol === 'http:';
  } catch {
    return false;
  }
}, 'not an http(s) URL');

export const SOURCE_TYPES = ['dated_deal_post', 'retailer_listing', 'price_history_series', 'price_comparison_listing', 'catalogue', 'news_article', 'archive_snapshot', 'other'] as const;

export const ModelObservation = z.object({
  amount_minor: z.number().int().positive().max(MAX_AMOUNT_MINOR),
  currency: z.string().length(3),
  date_start: isoDate,
  date_end: isoDate,
  date_precision: z.enum(['day', 'interval', 'month']),
  retailer: z.string().max(200).nullable(),
  source_name: z.string().min(1).max(200),
  source_url: httpUrl,
  source_type: z.enum(SOURCE_TYPES),
  evidence_excerpt: z.string().min(1).max(600),
  condition: z.enum(['new', 'used', 'refurbished', 'open_box', 'unknown']),
  shipping_minor: z.number().int().nonnegative().max(MAX_AMOUNT_MINOR).nullable(),
  tax_basis: z.enum(['included', 'excluded', 'unknown']),
  eligibility: z.enum(['public', 'member', 'coupon', 'trade_in', 'financing', 'bundle', 'restricted', 'unknown']),
  availability: z.enum(['in_stock', 'out_of_stock', 'preorder', 'unknown']),
  market: z.string().min(2).max(3),
  product_match: z.enum(['exact', 'uncertain']),
  reference_price_minor: z.number().int().positive().max(MAX_AMOUNT_MINOR).nullable(),
});
export type ModelObservation = z.infer<typeof ModelObservation>;

export const ModelLead = z.object({
  description: z.string().min(1).max(400),
  source_url: httpUrl.nullable(),
  reason: z.string().max(300),
  amount_minor: z.number().int().positive().max(MAX_AMOUNT_MINOR).nullable(),
  currency: z.string().max(3).nullable(),
  retailer: z.string().max(200).nullable(),
  date: z.string().max(40).nullable(),
});

// ------------------------------------------------------------------ text normalisation

export function normText(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/[\s   ]+/g, ' ')
    .toLowerCase()
    .trim();
}

export function alnum(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

export function normaliseUrl(u: string): string {
  try {
    const p = new URL(u);
    p.hash = '';
    // Drop common tracking parameters; keep the rest (they can identify a variant).
    for (const k of Array.from(p.searchParams.keys())) if (/^(utm_|fbclid|gclid|ref$|ref_)/i.test(k)) p.searchParams.delete(k);
    const host = p.hostname.toLowerCase().replace(/^www\./, '');
    const path = p.pathname.replace(/\/+$/, '') || '/';
    return `${host}${path}${p.search}`;
  } catch {
    return u;
  }
}

// ------------------------------------------------------------------ date evidence

const MONTHS: Record<string, string[]> = {
  en: ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'],
  de: ['januar', 'februar', 'märz', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'dezember'],
  et: ['jaanuar', 'veebruar', 'märts', 'aprill', 'mai', 'juuni', 'juuli', 'august', 'september', 'oktoober', 'november', 'detsember'],
};

/** Textual renderings of a date that would evidence it in a source. */
export function dateRenderings(iso: string, precision: 'day' | 'month'): string[] {
  const y = iso.slice(0, 4);
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  const out: string[] = [];
  for (const names of Object.values(MONTHS)) {
    const full = names[m - 1]!;
    const short = full.slice(0, 3);
    if (precision === 'month') {
      out.push(`${full} ${y}`, `${short} ${y}`);
    } else {
      out.push(`${d} ${full} ${y}`, `${d}. ${full} ${y}`, `${d} ${short} ${y}`, `${full} ${d}, ${y}`, `${short} ${d}, ${y}`, `${d}. ${short} ${y}`, `${full} ${d} ${y}`, `${short} ${d} ${y}`, `${d}th ${full} ${y}`, `${d}st ${full} ${y}`, `${d}nd ${full} ${y}`, `${d}rd ${full} ${y}`);
    }
  }
  if (precision === 'month') out.push(`${y}-${mm}`, `${mm}/${y}`, `${mm}.${y}`);
  else out.push(`${y}-${mm}-${dd}`, `${dd}.${mm}.${y}`, `${d}.${m}.${y}`, `${dd}/${mm}/${y}`, `${mm}/${dd}/${y}`, `${d}/${m}/${y}`, `${m}/${d}/${y}`, `${y}/${mm}/${dd}`);
  return out.map(normText);
}

function textHasDate(text: string, iso: string, precision: 'day' | 'month'): boolean {
  const t = normText(text);
  return dateRenderings(iso, precision).some((r) => {
    let idx = t.indexOf(r);
    while (idx !== -1) {
      const before = t[idx - 1] ?? ' ';
      const after = t[idx + r.length] ?? ' ';
      if (!/[0-9]/.test(before) && !/[0-9]/.test(after)) return true;
      idx = t.indexOf(r, idx + 1);
    }
    return false;
  });
}

// ------------------------------------------------------------------ market evidence

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

export type MarketCheck = 'match' | 'foreign' | 'unestablished';

export function sourceMarket(url: string, excerpt: string, market: Market): MarketCheck {
  const host = hostOf(url);
  const ownTlds = MARKET_TLDS[market.code] ?? [];
  if (ownTlds.some((t) => host.endsWith(t))) return 'match';
  if (FOREIGN_CCTLDS.some((t) => host.endsWith(t))) return 'foreign';
  if (seedSources(market.code).some((s) => host === s.domain || host.endsWith('.' + s.domain))) {
    // Seed sources on generic TLDs serve several markets (e.g. keepa.com): require an explicit hint.
    if (market.code === 'US' && /camelcamelcamel\.com$|slickdeals\.net$|dealnews\.com$|blackfriday\.com$/.test(host)) return 'match';
  }
  const lowerCode = market.code.toLowerCase();
  let path = '';
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    /* ignore */
  }
  const hostHint = host.startsWith(lowerCode + '.');
  const pathHint = new RegExp(`(^|/)([a-z]{2}[-_])?${lowerCode}(/|$|[-_])`).test(path);
  if (hostHint || pathHint) return 'match';
  const tokens = uniqueCurrencyTokens(market.currency);
  if (tokens.length && tokens.some((tok) => excerpt.toUpperCase().includes(tok.toUpperCase()))) return 'match';
  if (market.code === 'US' && /^(amazon|walmart|target|bestbuy|costco|homedepot)\.com$/.test(host)) return 'match';
  return 'unestablished';
}

// ------------------------------------------------------------------ validator

export interface ProductIdentity {
  brand: string | null;
  model: string | null;
  variant: string | null;
  gtin: string | null;
}

export interface ValidationContext {
  market: Market;
  product: ProductIdentity;
  corpus: EvidenceCorpus;
  todayLocal: string;
  /** For current offers the date is the retrieval date and need not appear in the source. */
  kind: 'historical' | 'current';
}

export type ValidationOutcome =
  | { status: 'verified'; doc: FetchedDoc; notes: string[] }
  | { status: 'lead'; reason: string }
  | { status: 'rejected'; reason: string };

/**
 * Identifier tokens that prove the page is about this product: the GTIN, and model/MPN-like
 * segments (letters+digits, e.g. "G91F", "LS49FG912EEXXY", "WH-1000XM5"). Any one must appear.
 */
export function productTokens(p: ProductIdentity): string[] {
  const toks = new Set<string>();
  if (p.gtin) toks.add(alnum(p.gtin));
  if (p.model) {
    const parts = p.model.split(/[\s(),;/|]+/).map((x) => x.replace(/["'’”]+/g, '')).filter(Boolean);
    for (const part of parts) {
      const a = alnum(part);
      if (a.length >= 4 && /\d/.test(a) && /\p{L}/u.test(a)) toks.add(a);
    }
    // Adjacent pairs catch split identifiers like "WH 1000XM5" or "GSR 12V-15".
    for (let i = 0; i + 1 < parts.length; i++) {
      const a = alnum(parts[i]! + parts[i + 1]!);
      if (a.length >= 5 && /\d/.test(a) && /\p{L}/u.test(a)) toks.add(a);
    }
    if (toks.size === 0 || (p.gtin && toks.size === 1)) {
      const whole = alnum(p.model);
      if (whole.length >= 3) toks.add(whole);
    }
  }
  return Array.from(toks);
}

// Price-relevant measured attributes only (storage, screen size, capacity, battery pack size).
const UNIT_ALIASES: Record<string, string> = { gb: 'gb', tb: 'tb', kg: 'kg', l: 'l', litre: 'l', liter: 'l', inch: 'in', in: 'in', '"': 'in', zoll: 'in', tolli: 'in', qt: 'qt', quart: 'qt', ah: 'ah' };
const MEASURE_RE = /(\d+(?:[.,]\d+)?)\s?-?\s?(gb|tb|kg|litre|liter|l|inch|in|"|zoll|tolli|qt|quart|ah)(?![a-z])/gi;

/** Price-relevant measured attributes ("256 GB", "65 inch", "8kg") normalised to value+unit. */
export function measures(text: string): { value: string; unit: string }[] {
  const out: { value: string; unit: string }[] = [];
  for (const m of text.toLowerCase().matchAll(MEASURE_RE)) {
    out.push({ value: String(Number(m[1]!.replace(',', '.'))), unit: UNIT_ALIASES[m[2]!.toLowerCase()] ?? m[2]!.toLowerCase() });
  }
  return out;
}

/**
 * Variant check: every measured attribute of the resolved variant must appear on the page, and the
 * excerpt must not quote a different value of the same unit without also quoting the target value.
 */
export function variantConflict(variant: string | null, pageText: string, excerpt: string): string | null {
  if (!variant) return null;
  const want = measures(variant);
  if (!want.length) return null;
  const page = measures(pageText);
  const ex = measures(excerpt);
  for (const w of want) {
    if (!page.some((p) => p.unit === w.unit && p.value === w.value)) return `The page does not mention the ${w.value} ${w.unit} variant.`;
    const exSame = ex.filter((e) => e.unit === w.unit);
    if (exSame.length && !exSame.some((e) => e.value === w.value)) return `The excerpt refers to a different variant (${exSame[0]!.value} ${w.unit}).`;
  }
  return null;
}

export function validateObservation(o: ModelObservation, ctx: ValidationContext): ValidationOutcome {
  const { market, corpus } = ctx;
  if (o.market.toUpperCase() !== market.code) return { status: 'rejected', reason: `Observation is for market ${o.market}, not ${market.code}.` };
  if (o.currency.toUpperCase() !== market.currency) return { status: 'rejected', reason: `Currency ${o.currency} does not match ${market.currency}.` };
  if (o.date_end < o.date_start) return { status: 'rejected', reason: 'Date interval is inverted.' };
  if (o.date_end > ctx.todayLocal) return { status: 'rejected', reason: 'Date is in the future.' };
  if (o.condition !== 'new') return { status: 'rejected', reason: `Condition is ${o.condition}, not new.` };
  if (o.date_precision === 'day' && o.date_start !== o.date_end) return { status: 'rejected', reason: 'Day precision with a date range.' };

  const mk = sourceMarket(o.source_url, o.evidence_excerpt, market);
  if (mk === 'foreign') return { status: 'rejected', reason: 'Source belongs to a different country market.' };

  const target = normaliseUrl(o.source_url);
  const doc = corpus.fetched.find((d) => normaliseUrl(d.url) === target);
  const seenInSearch = corpus.searchResults.some((r) => normaliseUrl(r.url) === target) || corpus.citations.some((c) => normaliseUrl(c.url) === target);
  if (!doc) {
    if (seenInSearch) return { status: 'lead', reason: 'Only a search snippet was available; the page was not retrieved and verified.' };
    return { status: 'rejected', reason: 'Source URL was not retrieved during this investigation.' };
  }
  if (doc.binary || !doc.text) return { status: 'lead', reason: 'Source content could not be read as text (e.g. PDF or image).' };
  if (mk === 'unestablished') return { status: 'lead', reason: 'The source does not establish that this price is for this market.' };
  if (o.product_match !== 'exact') return { status: 'lead', reason: 'Product or variant match is uncertain.' };

  const page = normText(doc.text);
  const excerpt = normText(o.evidence_excerpt);
  if (excerpt.length < 8 || !page.includes(excerpt)) return { status: 'lead', reason: 'The quoted excerpt was not found verbatim in the retrieved page.' };
  if (!amountsInText(o.evidence_excerpt).has(o.amount_minor)) return { status: 'lead', reason: 'The excerpt does not contain the stated amount.' };

  const toks = productTokens(ctx.product);
  const pageAlnum = alnum(doc.text);
  if (toks.length === 0 || !toks.some((t) => pageAlnum.includes(t))) return { status: 'lead', reason: 'The page does not mention the exact model identifier.' };

  const vc = variantConflict(ctx.product.variant, doc.text, o.evidence_excerpt);
  if (vc) return { status: 'lead', reason: vc };

  const notes: string[] = [];
  if (ctx.kind === 'historical') {
    const precision = o.date_precision === 'month' ? 'month' : 'day';
    const datesOk = textHasDate(o.evidence_excerpt, o.date_start, precision) || textHasDate(doc.text, o.date_start, precision);
    const endOk = o.date_start === o.date_end || precision === 'month' || textHasDate(doc.text, o.date_end, 'day');
    if (!datesOk || !endOk) return { status: 'lead', reason: 'The date is not stated in the retrieved page.' };
    if (!textHasDate(o.evidence_excerpt, o.date_start, precision)) notes.push('Date taken from elsewhere on the same page.');
  }
  return { status: 'verified', doc, notes };
}

export async function fingerprint(parts: (string | number | null)[]): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(parts.map((p) => String(p ?? '')).join('|')));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
}
