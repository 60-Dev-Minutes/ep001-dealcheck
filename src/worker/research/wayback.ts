// Internet Archive (Wayback Machine) price history. For retailer product pages already discovered in
// the selected market, look up archived snapshots inside the comparison windows and read the price
// deterministically from the page's structured data (schema.org JSON-LD / Open Graph / microdata).
// The snapshot timestamp is the observation date; the archived page is the evidence. No model calls.
// Only web.archive.org is contacted (fixed host): no user-controlled destinations, no retailer access.
import type { EventConfig, Market } from '../../shared/markets';
import { localDate } from '../admission';
import type { ObservationInput } from '../report/compute';
import { alnum, fingerprint, hostOf, productTokens, sourceMarket, variantConflict, type ProductIdentity } from './evidence';

const ARCHIVE = 'https://web.archive.org';
const USER_AGENT = 'DealCheck/1.0 (+https://dealcheck.kratt.nz; consumer price research, low volume)';
const MAX_HTML_BYTES = 2_000_000;

export interface WaybackLimits {
  maxUrls: number;
  maxSnapshots: number;
  perRequestMs: number;
  totalMs: number;
}

export const WAYBACK_LIMITS: WaybackLimits = { maxUrls: 3, maxSnapshots: 9, perRequestMs: 7000, totalMs: 28_000 };

export interface StructuredPrice {
  amount_minor: number;
  currency: string;
  pointer: string;
  availability: 'in_stock' | 'out_of_stock' | 'preorder' | 'unknown';
  aggregate: boolean;
}

// ------------------------------------------------------------------ structured data extraction

function priceToMinor(v: unknown): number | null {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  const m = s.match(/^(\d{1,9})(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const minor = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
  return minor > 0 ? minor : null;
}

function availabilityOf(v: unknown): StructuredPrice['availability'] {
  const s = String(v ?? '').toLowerCase();
  if (s.includes('instock') || s.includes('limitedavailability') || s.includes('onlineonly')) return 'in_stock';
  if (s.includes('outofstock') || s.includes('soldout') || s.includes('discontinued')) return 'out_of_stock';
  if (s.includes('preorder') || s.includes('presale')) return 'preorder';
  return 'unknown';
}

function typesOf(o: Record<string, unknown>): string[] {
  const t = o['@type'];
  return (Array.isArray(t) ? t : [t]).map((x) => String(x ?? '').toLowerCase());
}

function collectOffers(node: unknown, out: StructuredPrice[], inProduct: boolean, depth = 0): void {
  if (depth > 8 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) collectOffers(n, out, inProduct, depth + 1);
    return;
  }
  const o = node as Record<string, unknown>;
  const types = typesOf(o);
  const isProduct = types.some((t) => t === 'product' || t === 'productgroup' || t === 'individualproduct');
  if (inProduct && (types.includes('offer') || types.includes('aggregateoffer'))) {
    const aggregate = types.includes('aggregateoffer');
    const amount = priceToMinor(aggregate ? (o.lowPrice ?? o.price) : (o.price ?? (o.priceSpecification as Record<string, unknown> | undefined)?.price));
    const currency = String(o.priceCurrency ?? (o.priceSpecification as Record<string, unknown> | undefined)?.priceCurrency ?? '').toUpperCase();
    if (amount && /^[A-Z]{3}$/.test(currency)) {
      out.push({ amount_minor: amount, currency, availability: availabilityOf(o.availability), aggregate, pointer: `JSON-LD ${aggregate ? 'AggregateOffer.lowPrice' : 'Offer.price'} = ${(amount / 100).toFixed(2)} ${currency}` });
    }
  }
  for (const [k, v] of Object.entries(o)) {
    if (k === '@context') continue;
    collectOffers(v, out, inProduct || isProduct || k === '@graph', depth + 1);
  }
}

function metaContent(html: string, attr: 'property' | 'itemprop' | 'name', key: string): string | null {
  const re = new RegExp(`<meta[^>]+${attr}=["']${key.replace(/[:.]/g, '\\$&')}["'][^>]*>`, 'i');
  const tag = html.match(re)?.[0];
  return tag?.match(/content=["']([^"']*)["']/i)?.[1] ?? null;
}

/**
 * Deterministic price from structured data. Returns null when absent or ambiguous
 * (several different prices in the market currency), so nothing is guessed.
 */
export function extractStructuredPrice(html: string, currency: string): StructuredPrice | null {
  const found: StructuredPrice[] = [];
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      collectOffers(JSON.parse(m[1]!.trim()), found, false);
    } catch {
      /* malformed JSON-LD: ignore */
    }
  }
  const og = priceToMinor(metaContent(html, 'property', 'product:price:amount') ?? metaContent(html, 'property', 'og:price:amount'));
  const ogCur = (metaContent(html, 'property', 'product:price:currency') ?? metaContent(html, 'property', 'og:price:currency') ?? '').toUpperCase();
  if (og && ogCur) found.push({ amount_minor: og, currency: ogCur, availability: 'unknown', aggregate: false, pointer: `meta product:price:amount = ${(og / 100).toFixed(2)} ${ogCur}` });
  const mp = priceToMinor(metaContent(html, 'itemprop', 'price'));
  const mpCur = (metaContent(html, 'itemprop', 'priceCurrency') ?? '').toUpperCase();
  if (mp && mpCur) found.push({ amount_minor: mp, currency: mpCur, availability: 'unknown', aggregate: false, pointer: `microdata itemprop=price = ${(mp / 100).toFixed(2)} ${mpCur}` });

  const local = found.filter((f) => f.currency === currency);
  if (!local.length) return null;
  const amounts = new Set(local.map((f) => f.amount_minor));
  if (amounts.size !== 1) return null; // conflicting prices (variants, bundles, ex/inc tax): do not guess
  return local.find((f) => !f.aggregate) ?? local[0]!;
}

export function pageText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

const ID_FIELDS = ['name', 'sku', 'mpn', 'model', 'gtin', 'gtin8', 'gtin12', 'gtin13', 'gtin14', 'productID'];

function collectProductIds(node: unknown, out: string[], depth = 0): void {
  if (depth > 8 || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) collectProductIds(n, out, depth + 1); return; }
  const o = node as Record<string, unknown>;
  if (typesOf(o).some((t) => t === 'product' || t === 'productgroup' || t === 'individualproduct')) {
    for (const f of ID_FIELDS) {
      const v = o[f];
      if (typeof v === 'string' || typeof v === 'number') out.push(String(v));
      else if (v && typeof v === 'object' && typeof (v as Record<string, unknown>).name === 'string') out.push((v as Record<string, string>).name!);
    }
    return; // do not descend into isRelatedTo / isSimilarTo product lists
  }
  for (const [k, v] of Object.entries(o)) if (k !== 'isRelatedTo' && k !== 'isSimilarTo' && k !== 'isAccessoryOrSparePartFor') collectProductIds(v, out, depth + 1);
}

/**
 * Text that identifies the page's own product only: <title>, og:title, <h1>, and the Product's
 * name/sku/mpn/gtin in structured data. Body text is excluded because product pages also list
 * related or comparable models, which would otherwise match the wrong product.
 */
export function identityText(html: string): string {
  const ids: string[] = [];
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { collectProductIds(JSON.parse(m[1]!.trim()), ids); } catch { /* ignore */ }
  }
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '';
  const og = metaContent(html, 'property', 'og:title') ?? '';
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, ' ') ?? '';
  return `${title} ${og} ${h1} ${ids.join(' ')}`;
}

// ------------------------------------------------------------------ candidate URLs and snapshots

/** Product-page URLs in this market, best candidates first. */
export function candidateUrls(urls: string[], market: Market, product: ProductIdentity, max: number): string[] {
  const tokens = productTokens(product);
  const seen = new Set<string>();
  const scored: { url: string; score: number }[] = [];
  for (const raw of urls) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
    if (u.hostname.endsWith('archive.org')) continue;
    const key = `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`;
    if (seen.has(key) || u.pathname.length < 2) continue;
    if (sourceMarket(raw, '', market) !== 'match') continue;
    if (/\/(search|category|categories|hot-deals|deals|c|collections|filter|tag|blog|news)(\/|$)/i.test(u.pathname) && !/\/(product|products|p|dp|item)\//i.test(u.pathname)) continue;
    seen.add(key);
    const path = alnum(u.pathname + u.search);
    let score = 0;
    if (tokens.some((t) => path.includes(t))) score += 3;
    if (/\/(product|products|p|dp|item|prod)\//i.test(u.pathname)) score += 2;
    scored.push({ url: `${u.protocol}//${u.host}${u.pathname}${u.search}`, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, max).map((s) => s.url);
}

/** "host/product/ABC123" for URLs like host/product/ABC123/some-slug (first path segment with a digit). */
export function idPrefix(url: string): string | null {
  try {
    const u = new URL(url);
    const segs = u.pathname.split('/').filter(Boolean);
    const i = segs.findIndex((x) => /\d/.test(x) && x.length >= 4);
    if (i < 0 || i === segs.length - 1) return null;
    return `${u.hostname}/${segs.slice(0, i + 1).join('/')}/`;
  } catch {
    return null;
  }
}

export interface Snapshot {
  timestamp: string; // YYYYMMDDhhmmss (UTC)
  original: string;
}

export function snapshotIso(ts: string): string {
  return `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(8, 10)}:${ts.slice(10, 12)}:${ts.slice(12, 14)}Z`;
}

/**
 * Pick snapshots: the previous event day first (market-local), then one per month across the
 * off-season (latest month first), capped. Same-local-day duplicates are dropped.
 */
export function selectSnapshots(snaps: Snapshot[], cfg: EventConfig, tz: string, todayLocal: string, max: number): Snapshot[] {
  const byDay = new Map<string, Snapshot>();
  for (const s of snaps) {
    if (!/^\d{14}$/.test(s.timestamp)) continue;
    const d = localDate(new Date(snapshotIso(s.timestamp)), tz);
    if (d < cfg.previous_event_date || d >= todayLocal) continue;
    if (!byDay.has(d)) byDay.set(d, s);
  }
  const picked: Snapshot[] = [];
  const event = byDay.get(cfg.previous_event_date);
  if (event) picked.push(event);
  const months = new Map<string, Snapshot>();
  for (const [d, s] of Array.from(byDay.entries()).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (d === cfg.previous_event_date) continue;
    const m = d.slice(0, 7);
    if (!months.has(m)) months.set(m, s);
  }
  for (const s of Array.from(months.values()).reverse()) {
    if (picked.length >= max) break;
    picked.push(s);
  }
  return picked;
}

// ------------------------------------------------------------------ orchestration

export interface WaybackResult {
  observations: ObservationInput[];
  log: { cdx_queries: number; snapshots_fetched: number; urls: string[]; misses: string[] };
}

async function timedFetch(fetcher: typeof fetch, url: string, ms: number, deadline: number): Promise<Response | null> {
  const remaining = deadline - Date.now();
  if (remaining < 500) return null;
  try {
    return await fetcher(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/json' }, signal: AbortSignal.timeout(Math.min(ms, remaining)), redirect: 'follow' });
  } catch {
    return null;
  }
}

async function readCapped(res: Response): Promise<string | null> {
  const len = Number(res.headers.get('content-length') ?? '0');
  if (len > MAX_HTML_BYTES) return null;
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_HTML_BYTES) return null;
  return new TextDecoder('utf-8').decode(buf);
}

export async function waybackObservations(
  urls: string[],
  market: Market,
  product: ProductIdentity,
  cfg: EventConfig,
  todayLocal: string,
  fetcher: typeof fetch = fetch,
  limits: WaybackLimits = WAYBACK_LIMITS,
): Promise<WaybackResult> {
  const deadline = Date.now() + limits.totalMs;
  const result: WaybackResult = { observations: [], log: { cdx_queries: 0, snapshots_fetched: 0, urls: [], misses: [] } };
  const tokens = productTokens(product);
  if (!tokens.length) return result;
  const targets = candidateUrls(urls, market, product, limits.maxUrls);
  result.log.urls = targets.map(hostOf);
  const from = cfg.previous_event_date.replace(/-/g, '');
  const to = todayLocal.replace(/-/g, '');
  let budget = limits.maxSnapshots;
  for (const target of targets) {
    if (budget <= 0) break;
    const stripped = target.replace(/^https?:\/\//, '');
    // Exact URL first; then the product-id prefix (slugs and tracking variants change over time).
    const queries = [`url=${encodeURIComponent(stripped)}`];
    const prefix = idPrefix(target);
    if (prefix) queries.push(`url=${encodeURIComponent(prefix)}&matchType=prefix`);
    let rows: string[][] = [];
    let indexOk = false;
    for (const q of queries) {
      const cdxUrl = `${ARCHIVE}/cdx/search/cdx?${q}&from=${from}&to=${to}&output=json&fl=timestamp,original,statuscode,mimetype&filter=statuscode:200&filter=mimetype:text/html&collapse=timestamp:8&limit=400`;
      result.log.cdx_queries++;
      const res = await timedFetch(fetcher, cdxUrl, limits.perRequestMs, deadline);
      if (!res || !res.ok) continue;
      indexOk = true;
      try {
        rows = (await res.json()) as string[][];
      } catch {
        rows = [];
      }
      if (rows.length > 1) break;
    }
    if (!indexOk) { result.log.misses.push(`${hostOf(target)}: index unavailable`); continue; }
    const snaps = rows.slice(1).map((r) => ({ timestamp: r[0] ?? '', original: r[1] ?? target }));
    if (!snaps.length) { result.log.misses.push(`${hostOf(target)}: no snapshots in window`); continue; }
    const chosen = selectSnapshots(snaps, cfg, market.timezone, todayLocal, Math.min(budget, Math.ceil(limits.maxSnapshots / targets.length) + 1));
    for (const snap of chosen) {
      if (budget <= 0) break;
      budget--;
      const archived = `${ARCHIVE}/web/${snap.timestamp}id_/${snap.original}`;
      const page = await timedFetch(fetcher, archived, limits.perRequestMs, deadline);
      if (!page || !page.ok) continue;
      result.log.snapshots_fetched++;
      const html = await readCapped(page);
      if (!html) continue;
      const price = extractStructuredPrice(html, market.currency);
      if (!price) continue;
      const ident = identityText(html);
      if (!tokens.some((t) => alnum(ident).includes(t))) continue;
      if (variantConflict(product.variant, ident, ident)) continue;
      const date = localDate(new Date(snapshotIso(snap.timestamp)), market.timezone);
      const viewUrl = `${ARCHIVE}/web/${snap.timestamp}/${snap.original}`;
      const host = hostOf(snap.original);
      result.observations.push({
        id: await fingerprint(['wayback', snap.original, snap.timestamp, price.amount_minor]),
        amount_minor: price.amount_minor,
        currency: price.currency,
        date_start: date,
        date_end: date,
        date_precision: 'day',
        retailer: price.aggregate ? null : host,
        source_name: `Internet Archive snapshot of ${host}`,
        source_url: viewUrl,
        source_domain: host,
        source_type: price.aggregate ? 'price_comparison_listing' : 'archive_snapshot',
        excerpt: `${price.pointer} (archived ${snapshotIso(snap.timestamp).replace('T', ' ').replace('Z', ' UTC')})`,
        retrieved_at: new Date().toISOString(),
        tax_basis: 'unknown',
        eligibility: 'public',
        shipping_minor: null,
      });
    }
  }
  return result;
}
