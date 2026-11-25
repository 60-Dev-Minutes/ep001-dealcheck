import { describe, expect, it } from 'vitest';
import { EVENT_CONFIG } from '../src/shared/markets';
import type { AssessedOffer } from '../src/shared/types';
import { annotate, classifyWindow, coverage, decideVerdict, isPrimary, minimum, percentOf, type ObservationInput } from '../src/worker/report/compute';

const AS_OF = '2026-11-27';
let n = 0;
function o(amount: number, date: string, extra: Partial<ObservationInput> = {}): ObservationInput {
  n++;
  return {
    id: `o${n}`, amount_minor: amount, currency: 'NZD', date_start: date, date_end: date, date_precision: 'day', retailer: 'R',
    source_name: 's', source_url: `https://shop${n % 3}-store.nz/p`, source_domain: `shop${n % 3}-store.nz`, source_type: 'dated_deal_post',
    excerpt: 'x', retrieved_at: '2026-11-27T00:00:00Z', tax_basis: 'included', eligibility: 'public', shipping_minor: null, ...extra,
  };
}
const assessed = (amount: number, extra: Partial<AssessedOffer> = {}): AssessedOffer => ({
  amount_minor: amount, currency: 'NZD', basis: 'verified_offer', retailer: 'R', source_url: null, availability: 'in_stock',
  tax_basis: 'included', as_of: '2026-11-27T00:00:00Z', as_of_local_date: AS_OF, verified_match: 'matches', verified_amount_minor: amount, ...extra,
});
const run = (c: number, obs: ObservationInput[], a = assessed(c), market = 'NZ') => {
  const ann = annotate(obs, a, market, EVENT_CONFIG, AS_OF);
  const primary = ann.filter(isPrimary);
  const cov = coverage(primary, EVENT_CONFIG, AS_OF);
  return { ann, primary, cov, verdict: decideVerdict(c, primary, cov) };
};

describe('windows', () => {
  it('classifies the fixed episode windows', () => {
    expect(classifyWindow({ date_start: '2025-11-28', date_end: '2025-11-28' }, EVENT_CONFIG, AS_OF)).toBe('previous_event');
    expect(classifyWindow({ date_start: '2025-11-29', date_end: '2025-11-29' }, EVENT_CONFIG, AS_OF)).toBe('offseason');
    expect(classifyWindow({ date_start: '2026-11-26', date_end: '2026-11-26' }, EVENT_CONFIG, AS_OF)).toBe('offseason');
    expect(classifyWindow({ date_start: '2025-11-27', date_end: '2025-11-27' }, EVENT_CONFIG, AS_OF)).toBe('earlier_context');
    expect(classifyWindow({ date_start: '2025-11-20', date_end: '2025-12-02' }, EVENT_CONFIG, AS_OF)).toBe('straddles_window');
    expect(classifyWindow({ date_start: '2026-11-28', date_end: '2026-11-28' }, EVENT_CONFIG, '2026-11-30')).toBe('current_event');
  });
  it('same-day observations are not treated as earlier', () => {
    expect(classifyWindow({ date_start: AS_OF, date_end: AS_OF }, EVENT_CONFIG, AS_OF)).toBe('same_day_unordered');
    expect(classifyWindow({ date_start: '2026-11-28', date_end: '2026-11-28' }, EVENT_CONFIG, AS_OF)).toBe('after_offer');
    // Off-season is clipped to strictly before the assessed offer when used before the event.
    expect(classifyWindow({ date_start: '2026-11-20', date_end: '2026-11-20' }, EVENT_CONFIG, '2026-11-20')).toBe('same_day_unordered');
  });
});

describe('verdict precedence', () => {
  it('insufficient without evidence or without a price', () => {
    expect(run(79900, []).verdict).toBe('insufficient_evidence');
    const { primary, cov } = run(79900, [o(70000, '2026-05-01')]);
    // Verified history but no usable current price: reported as history, not as missing evidence.
    expect(decideVerdict(null, primary, cov)).toBe('history_only');
    expect(decideVerdict(null, [], cov)).toBe('insufficient_evidence');
  });
  it('a single lower verified price means cheaper before', () => expect(run(79900, [o(79899, '2026-05-01')]).verdict).toBe('cheaper_before'));
  it('exact equality in minor units is price matched', () => {
    expect(run(79900, [o(79900, '2026-05-01'), o(85000, '2026-06-01')]).verdict).toBe('price_matched_before');
    expect(run(79900, [o(79901, '2026-05-01')]).verdict).toBe('limited_history');
  });
  it('cheaper beats matched', () => expect(run(79900, [o(79900, '2026-05-01'), o(70000, '2026-06-01')]).verdict).toBe('cheaper_before'));
  it('lowest observed needs coverage threshold', () => {
    const thin = run(70000, [o(80000, '2026-01-10'), o(85000, '2026-02-10')]);
    expect(thin.verdict).toBe('limited_history');
    const rich = run(70000, [o(80000, '2025-12-10'), o(85000, '2026-04-10'), o(90000, '2026-08-10')]);
    expect(rich.cov.distinct_origins).toBeGreaterThanOrEqual(2);
    expect(rich.cov.threshold_met).toBe(true);
    expect(rich.verdict).toBe('lowest_observed');
  });
  it('a 90-day continuous series meets coverage', () => {
    const series = o(90000, '2026-01-01', { date_end: '2026-06-01', date_precision: 'interval', source_type: 'price_history_series' });
    expect(run(70000, [series]).verdict).toBe('lowest_observed');
  });
  it('same-day and later observations do not establish cheaper before', () => {
    expect(run(79900, [o(50000, AS_OF)]).verdict).toBe('insufficient_evidence');
  });
  it('earlier-than-window prices are context only', () => {
    const r = run(79900, [o(50000, '2025-06-01')]);
    expect(r.verdict).toBe('insufficient_evidence');
    expect(r.ann[0]!.window).toBe('earlier_context');
  });
});

describe('comparability', () => {
  it('restricted and member offers are separated', () => {
    expect(run(79900, [o(50000, '2026-05-01', { eligibility: 'member' })]).verdict).toBe('insufficient_evidence');
    expect(run(79900, [o(50000, '2026-05-01', { eligibility: 'coupon' })]).verdict).toBe('insufficient_evidence');
  });
  it('does not compare pre-tax with tax-inclusive', () => {
    const r = run(79900, [o(50000, '2026-05-01', { tax_basis: 'excluded', currency: 'USD' })], assessed(79900, { currency: 'USD', tax_basis: 'included' }), 'US');
    expect(r.verdict).toBe('insufficient_evidence');
  });
  it('US unknown tax basis is treated as pre-tax shelf price on both sides', () => {
    const r = run(79900, [o(50000, '2026-05-01', { tax_basis: 'unknown', currency: 'USD' })], assessed(79900, { currency: 'USD', tax_basis: 'unknown' }), 'US');
    expect(r.verdict).toBe('cheaper_before');
  });
  it('never compares a different currency', () => {
    expect(run(79900, [o(100, '2026-05-01', { currency: 'AUD' })]).verdict).toBe('insufficient_evidence');
  });
  it('unknown shipping is noted, not zero', () => {
    const r = run(79900, [o(70000, '2026-05-01')]);
    expect(r.ann[0]!.comparability_notes.join(' ')).toMatch(/Delivery cost unknown/);
  });
});

describe('arithmetic', () => {
  it('computes difference and percentage from minor units', () => {
    const m = minimum(79900, run(79900, [o(74900, '2025-11-28')]).primary)!;
    expect(m.difference_minor).toBe(5000);
    expect(m.percent).toBe(6.7);
    expect(percentOf(-5000, 79900)).toBe(-6.3);
    expect(percentOf(1, 3)).toBe(33.3);
  });
  it('reports previous event and off-season independently', () => {
    const r = run(79900, [o(74900, '2025-11-28'), o(77900, '2026-07-10')]);
    expect(minimum(79900, r.primary.filter((x) => x.window === 'previous_event'))!.minimum_minor).toBe(74900);
    expect(minimum(79900, r.primary.filter((x) => x.window === 'offseason'))!.minimum_minor).toBe(77900);
  });
  it('coverage lists missing months', () => {
    const r = run(79900, [o(74900, '2025-11-28'), o(77900, '2026-07-10')]);
    expect(r.cov.months_represented).toEqual(['2025-11', '2026-07']);
    expect(r.cov.months_missing).toContain('2026-03');
    expect(r.cov.months_missing).not.toContain('2026-07');
  });
});

import { historicalLow, verdictText } from '../src/worker/report/compute';
describe('no current price', () => {
  it('still reports verified history, coverage and the historical low', () => {
    const obs = [o(139900, '2026-10-07'), o(129900, '2026-09-06'), o(159900, '2026-08-23')];
    const ann = annotate(obs, null, 'AU', EVENT_CONFIG, AS_OF, 'NZD');
    const primary = ann.filter(isPrimary);
    expect(primary).toHaveLength(3);
    const cov = coverage(primary, EVENT_CONFIG, AS_OF);
    expect(cov.months_represented).toEqual(['2026-08', '2026-09', '2026-10']);
    const low = historicalLow(primary)!;
    expect(low.minimum_minor).toBe(129900);
    expect(decideVerdict(null, primary, cov)).toBe('history_only');
    expect(verdictText('history_only', null, null, cov, low)).toMatch(/3 verified prices since the previous Black Friday.*lowest was NZD 1,299.00 on 2026-09-06.*add the advertised price/);
  });
  it('without a market currency baseline nothing is comparable (legacy behaviour)', () => {
    expect(annotate([o(1, '2026-10-07')], null, 'NZ', EVENT_CONFIG, AS_OF).filter(isPrimary)).toHaveLength(0);
  });
});

import { quoteLink } from '../src/worker/report/compute';
describe('proof links', () => {
  it('builds a text-fragment link to the quoted passage', () => {
    expect(quoteLink('https://shop.co.nz/p#x', 'now $749.00')).toBe('https://shop.co.nz/p#:~:text=now%20%24749.00');
    const long = quoteLink('https://shop.co.nz/p', 'Black Friday deal 28 November 2025: Fixture Phone FX-100 128 GB for NZD 749.00');
    expect(long).toBe('https://shop.co.nz/p#:~:text=Black%20Friday%20deal%2028%20November,GB%20for%20NZD%20749.00');
    expect(quoteLink('https://a.nz/p', 'pre-order, now 5')).toBe('https://a.nz/p#:~:text=pre%2Dorder%2C%20now%205');
  });
});
