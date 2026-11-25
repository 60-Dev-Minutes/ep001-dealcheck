// Deterministic pricing comparison. No model involvement: all arithmetic in integer minor units.
import type { EventConfig } from '../../shared/markets';
import type {
  AssessedOffer,
  Comparison,
  Coverage,
  ReportCondition,
  ReportObservation,
  TaxBasis,
  Verdict,
  Window,
} from '../../shared/types';
import { formatMoney } from '../../shared/money';

export const CALCULATION_VERSION = 'calc-1.0.0';
export const COVERAGE_RULE =
  'At least 3 distinct dated comparable observations spanning at least 90 days from at least 2 independent origins, or a verified continuous price series covering at least 90 days.';

export type ObservationInput = Omit<ReportObservation, 'window' | 'comparable' | 'comparability_notes'>;

/** Text-fragment link that opens the source and highlights the quoted passage (where browsers support it). */
export function quoteLink(url: string, excerpt: string): string {
  const words = excerpt.replace(/\s+/g, ' ').trim().split(' ');
  const enc = (s: string) => encodeURIComponent(s).replace(/-/g, '%2D').replace(/,/g, '%2C');
  const frag = words.length <= 10 ? enc(words.join(' ')) : `${enc(words.slice(0, 5).join(' '))},${enc(words.slice(-4).join(' '))}`;
  return `${url.split('#')[0]}#:~:text=${frag}`;
}

export function classifyWindow(o: { date_start: string; date_end: string }, cfg: EventConfig, asOfLocal: string): Window {
  if (o.date_start > asOfLocal) return 'after_offer';
  // Not strictly before the assessed offer: ordering within the same day is unknown.
  if (o.date_end >= asOfLocal) return 'same_day_unordered';
  if (o.date_end < cfg.previous_event_date) return 'earlier_context';
  if (o.date_start === cfg.previous_event_date && o.date_end === cfg.previous_event_date) return 'previous_event';
  if (o.date_start >= cfg.offseason_start && o.date_end <= cfg.offseason_end) return 'offseason';
  if (o.date_start >= cfg.current_event_start) return 'current_event';
  return 'straddles_window';
}

/** Local consumer display norm for tax when a source does not say. */
export function taxNorm(market: string): TaxBasis {
  return market === 'US' ? 'excluded' : 'included';
}

export function comparability(
  o: ObservationInput,
  assessed: Pick<AssessedOffer, 'currency' | 'tax_basis'>,
  market: string,
): { comparable: boolean; notes: string[] } {
  const notes: string[] = [];
  let ok = true;
  if (o.currency !== assessed.currency) {
    ok = false;
    notes.push(`Different currency (${o.currency}); foreign prices are never converted for comparison.`);
  }
  if (o.eligibility !== 'public') {
    ok = false;
    notes.push(`Restricted offer (${o.eligibility.replace('_', '-')}); shown separately, not compared with a public price.`);
  }
  const norm = taxNorm(market);
  const obsTax = o.tax_basis === 'unknown' ? norm : o.tax_basis;
  const curTax = assessed.tax_basis === 'unknown' ? norm : assessed.tax_basis;
  if (o.tax_basis === 'unknown') notes.push(`Tax basis not stated; assumed ${norm === 'included' ? 'tax-inclusive' : 'pre-tax'} per local price display norm.`);
  if (obsTax !== curTax) {
    ok = false;
    notes.push('Different tax basis (pre-tax vs tax-inclusive); not compared.');
  }
  if (o.shipping_minor === null) notes.push('Delivery cost unknown (not treated as zero); item prices compared.');
  return { comparable: ok, notes };
}

export function annotate(observations: ObservationInput[], assessed: AssessedOffer | null, market: string, cfg: EventConfig, asOfLocal: string, marketCurrencyCode?: string): ReportObservation[] {
  return observations.map((o) => {
    const window = classifyWindow(o, cfg, asOfLocal);
    // Without an assessed price, judge comparability against the market's public, local-currency norm
    // so verified history (and coverage) is still reported.
    const baseline = assessed ?? (marketCurrencyCode ? { currency: marketCurrencyCode, tax_basis: 'unknown' as const } : null);
    const c = baseline ? comparability(o, baseline, market) : { comparable: false, notes: ['No assessed offer to compare against.'] };
    if (window === 'same_day_unordered') c.notes.push('Same date as (or later than) the assessed offer; not counted as an earlier price.');
    if (window === 'straddles_window') c.notes.push('Date range crosses a comparison window boundary; excluded from exact arithmetic.');
    return { ...o, window, comparable: c.comparable, comparability_notes: c.notes };
  });
}

export function isPrimary(o: ReportObservation): boolean {
  return o.comparable && (o.window === 'previous_event' || o.window === 'offseason');
}

export function minimum(c: number, obs: ReportObservation[]): Comparison | null {
  if (obs.length === 0) return null;
  let best = obs[0]!;
  for (const o of obs) if (o.amount_minor < best.amount_minor || (o.amount_minor === best.amount_minor && o.date_start < best.date_start)) best = o;
  const h = best.amount_minor;
  return {
    minimum_minor: h,
    observation_id: best.id,
    date: best.date_start === best.date_end ? best.date_start : `${best.date_start}/${best.date_end}`,
    difference_minor: c - h,
    percent: percentOf(c - h, h),
  };
}

/** Signed percentage, one decimal, half away from zero, computed from integers. */
export function percentOf(numer: number, denom: number): number {
  if (denom <= 0) return 0;
  const scaled = (numer * 1000) / denom; // tenths of a percent
  const rounded = Math.sign(scaled) * Math.round(Math.abs(scaled));
  return rounded / 10;
}

export function domainOrigin(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    const labels = host.split('.');
    const sld = labels.slice(-2).join('.');
    const twoLevel = /^(co|com|net|org|gov|ac|edu)\.[a-z]{2}$/.test(sld);
    return labels.slice(twoLevel ? -3 : -2).join('.');
  } catch {
    return 'invalid';
  }
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86_400_000);
}

function monthsInRange(start: string, end: string): string[] {
  const out: string[] = [];
  let y = Number(start.slice(0, 4));
  let m = Number(start.slice(5, 7));
  const ey = Number(end.slice(0, 4));
  const em = Number(end.slice(5, 7));
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

export function coverage(primary: ReportObservation[], cfg: EventConfig, asOfLocal: string): Coverage {
  const windowEnd = asOfLocal <= cfg.offseason_end ? prevDay(asOfLocal) : cfg.offseason_end;
  const allMonths = windowEnd >= cfg.previous_event_date ? monthsInRange(cfg.previous_event_date, windowEnd) : [];
  if (primary.length === 0) {
    return {
      comparable_observations: 0, distinct_dates: 0, date_range: null, span_days: 0, distinct_origins: 0,
      months_represented: [], months_missing: allMonths, threshold_met: false, threshold_rule: COVERAGE_RULE,
    };
  }
  const dated = primary.filter((o) => o.date_precision === 'day');
  const distinctDates = new Set(dated.map((o) => o.date_start)).size;
  const start = primary.reduce((a, o) => (o.date_start < a ? o.date_start : a), primary[0]!.date_start);
  const end = primary.reduce((a, o) => (o.date_end > a ? o.date_end : a), primary[0]!.date_end);
  // Archived snapshots count towards the original retailer, not the archive.
  const origins = new Set(primary.map((o) => domainOrigin(`https://${o.source_domain}/`))).size;
  const months = new Set<string>();
  for (const o of primary) {
    if (o.date_precision === 'day' || o.source_type === 'price_history_series') for (const mo of monthsInRange(o.date_start, o.date_end)) months.add(mo);
    else if (o.date_start.slice(0, 7) === o.date_end.slice(0, 7)) months.add(o.date_start.slice(0, 7));
  }
  const datedSpan = dated.length ? daysBetween(dated.reduce((a, o) => (o.date_start < a ? o.date_start : a), dated[0]!.date_start), dated.reduce((a, o) => (o.date_end > a ? o.date_end : a), dated[0]!.date_end)) : 0;
  const discreteOk = distinctDates >= 3 && datedSpan >= 90 && origins >= 2;
  const seriesOk = primary.some((o) => o.source_type === 'price_history_series' && daysBetween(o.date_start, o.date_end) >= 90);
  const represented = Array.from(months).sort();
  return {
    comparable_observations: primary.length,
    distinct_dates: distinctDates,
    date_range: { start, end },
    span_days: daysBetween(start, end),
    distinct_origins: origins,
    months_represented: represented,
    months_missing: allMonths.filter((m) => !months.has(m)),
    threshold_met: discreteOk || seriesOk,
    threshold_rule: COVERAGE_RULE,
  };
}

function prevDay(d: string): string {
  return new Date(Date.parse(d + 'T00:00:00Z') - 86_400_000).toISOString().slice(0, 10);
}

export function decideVerdict(c: number | null, primary: ReportObservation[], cov: Coverage): Verdict {
  if (c === null) return primary.length ? 'history_only' : 'insufficient_evidence';
  if (primary.length === 0) return 'insufficient_evidence';
  if (primary.some((o) => o.amount_minor < c)) return 'cheaper_before';
  if (primary.some((o) => o.amount_minor === c)) return 'price_matched_before';
  return cov.threshold_met ? 'lowest_observed' : 'limited_history';
}

export interface HistoricalLow {
  minimum_minor: number;
  currency: string;
  date: string;
  observation_id: string;
  source_domain: string;
}

/** Lowest verified comparable price in the windows, independent of any current price. */
export function historicalLow(primary: ReportObservation[]): HistoricalLow | null {
  if (!primary.length) return null;
  const best = primary.reduce((a, o) => (o.amount_minor < a.amount_minor || (o.amount_minor === a.amount_minor && o.date_start < a.date_start) ? o : a));
  return {
    minimum_minor: best.amount_minor, currency: best.currency, observation_id: best.id, source_domain: best.source_domain,
    date: best.date_start === best.date_end ? best.date_start : `${best.date_start}/${best.date_end}`,
  };
}

export function verdictText(v: Verdict, assessed: AssessedOffer | null, overall: Comparison | null, cov: Coverage, low: HistoricalLow | null = null): string {
  if (v === 'history_only' && low) {
    const n = cov.comparable_observations;
    return `We found ${n} verified price${n === 1 ? '' : 's'} since the previous Black Friday — the lowest was ${formatMoney(low.minimum_minor, low.currency)} on ${low.date}. We couldn't confirm today's price, so add the advertised price to see whether the current deal beats it.`;
  }
  const cur = assessed ? formatMoney(assessed.amount_minor, assessed.currency) : null;
  const min = overall && assessed ? formatMoney(overall.minimum_minor, assessed.currency) : null;
  const label = assessed?.basis === 'user_entered' ? 'your entered price' : 'the current offer';
  switch (v) {
    case 'history_only':
      return 'We found verified price history, but could not confirm today\'s price. Add the advertised price to compare.';
    case 'insufficient_evidence':
      return assessed
        ? `We could not find a verified, comparable earlier price for this exact product in this market, so no comparison can be made. That does not mean it was never cheaper.`
        : `We could not establish a usable current price, so no comparison can be made.`;
    case 'cheaper_before':
      return `Yes. A verified comparable offer of ${min} on ${overall?.date} was lower than ${label} of ${cur} (${Math.abs(overall?.percent ?? 0)}% below it).`;
    case 'price_matched_before':
      return `${cur} has been available before (${overall?.date}). We found no lower comparable price since the previous Black Friday.`;
    case 'lowest_observed':
      return `${cur} is below every verified comparable price we found (${cov.comparable_observations} observations, ${cov.span_days} days, ${cov.distinct_origins} independent sources). This is the lowest observed price, not proof of an all-time low.`;
    case 'limited_history':
      return `${cur} is below the ${cov.comparable_observations} comparable price${cov.comparable_observations === 1 ? '' : 's'} we could verify, but the evidence is too thin to call it the lowest price. Broader history is unknown.`;
  }
}

export function reportCondition(assessed: AssessedOffer | null, primary: ReportObservation[], cov: Coverage): ReportCondition {
  if (!assessed || (assessed.basis === 'user_entered' && assessed.verified_match !== 'matches')) return 'current_price_unverified';
  if (primary.length === 0) return 'no_historical_evidence';
  if (!cov.threshold_met) return 'partial_evidence';
  return 'ok';
}

export function normaliseRetailer(r: string | null): string | null {
  if (!r) return null;
  return r.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\b(nz|au|us|de|ee|online|store|shop|ltd|limited|inc|gmbh)\b/g, '').trim() || null;
}
