import { useEffect, type ReactNode } from 'react';
import type {
  AssessedOffer,
  ReportLead,
  Comparison,
  Eligibility,
  ReportCondition,
  ReportObservation,
  ReportSnapshot,
  TaxBasis,
  Verdict,
  Window,
} from '../../shared/types';
import { formatMoney } from '../../shared/money';
import {
  formatComparisonDate,
  formatDate,
  formatDateRange,
  formatDuration,
  formatLocalDateTime,
  formatMonth,
  formatPercentAbs,
  formatWallClock,
  safeHref,
} from '../util';
import { PriceChart } from './PriceChart';

// Everything here is rendered as text. Snapshot strings are never interpreted as HTML.

const VERDICT_LABELS: Record<Verdict, string> = {
  insufficient_evidence: 'Insufficient evidence',
  cheaper_before: 'Cheaper before',
  price_matched_before: 'Price matched before',
  lowest_observed: 'Lowest observed price',
  limited_history: 'Limited history',
};

const WINDOW_LABELS: Record<Window, string> = {
  previous_event: 'Previous Black Friday',
  offseason: 'Off-season',
  current_event: 'Current sale period',
  earlier_context: 'Earlier (context only)',
  straddles_window: 'Crosses a window boundary',
  same_day_unordered: 'Same day as assessed price',
  after_offer: 'After assessed price',
};

const AVAILABILITY_LABELS: Record<AssessedOffer['availability'], string> = {
  in_stock: 'In stock',
  out_of_stock: 'Out of stock',
  preorder: 'Pre-order',
  unknown: 'Unknown',
};

const TAX_LABELS: Record<TaxBasis, string> = {
  included: 'Tax included',
  excluded: 'Before tax',
  unknown: 'Tax basis not stated',
};

const ELIGIBILITY_LABELS: Record<Eligibility, string | null> = {
  public: null,
  member: 'Members only',
  coupon: 'Coupon required',
  trade_in: 'Requires trade-in',
  financing: 'Financing offer',
  bundle: 'Bundle',
  restricted: 'Restricted offer',
  unknown: 'Eligibility unknown',
};

const CONDITION_NOTES: Record<Exclude<ReportCondition, 'ok'>, { title: string; body: string }> = {
  current_price_unverified: {
    title: 'Current price unverified',
    body: 'We could not confirm the current price with a retailer listing, so the comparison rests on the price shown below. Check it yourself before buying.',
  },
  no_historical_evidence: {
    title: 'No historical evidence',
    body: 'We found no verified, comparable earlier prices for this exact product in this market. That does not mean it was never cheaper — only that we could not prove it.',
  },
  partial_evidence: {
    title: 'Partial evidence',
    body: 'We found some comparable earlier prices, but not enough to meet the coverage rule below. Treat the verdict with caution.',
  },
};

interface Props {
  snapshot: ReportSnapshot;
  onNewCheck: () => void;
}

export function Report({ snapshot: s, onNewCheck }: Props) {
  const currency = s.assessed?.currency ?? s.market.currency;
  const byId = new Map(s.observations.map((o) => [o.id, o] as const));
  // Older snapshots have no structured lead prices; treat missing fields as null.
  const pricedLeads = s.leads.filter((l): l is ReportLead & { amount_minor: number } => typeof l.amount_minor === 'number' && l.currency === s.market.currency);
  const textLeads = s.leads.filter((l) => !(typeof l.amount_minor === 'number' && l.currency === s.market.currency));
  const verifiedCount = s.observations.length + s.current_alternatives.length;

  // The report replaces the progress view: move focus to its heading.
  useEffect(() => {
    document.getElementById('job-title')?.focus();
  }, []);

  return (
    <article className="stack report" aria-labelledby="job-title">
      {s.synthetic_fixture && (
        <div className="synthetic-banner" role="note">
          <strong>SYNTHETIC TEST DATA — not real prices</strong>
          <span>This report was generated from test fixtures to demonstrate the format. Do not use it to make a purchase decision.</span>
        </div>
      )}

      <header className="report-head">
        <p className="eyebrow">
          Price history report · {s.market.name} ({s.market.currency})
        </p>
        <h1 id="job-title" tabIndex={-1}>
          {s.product.label}
        </h1>
        <ProductFacts product={s.product} />
      </header>

      <section className={`card verdict verdict-${s.verdict}`} aria-labelledby="verdict-title">
        <p className="eyebrow">Verdict</p>
        <h2 id="verdict-title" className="verdict-headline">
          {VERDICT_LABELS[s.verdict]}
        </h2>
        <p className="verdict-text">{s.verdict_text}</p>
        <PriceSummary verified={verifiedCount} leads={pricedLeads} currency={s.market.currency} />
        {s.condition !== 'ok' && (
          <div className={`condition-note condition-${s.condition}`} role="note">
            <p className="alert-title">{CONDITION_NOTES[s.condition].title}</p>
            <p>
              {s.condition === 'current_price_unverified' && !s.assessed
                ? 'We could not establish a current price for this product, so no comparison can be made.'
                : CONDITION_NOTES[s.condition].body}
            </p>
          </div>
        )}
      </section>

      <AssessedCard assessed={s.assessed} />

      <section aria-labelledby="cmp-title" className="stack-sm">
        <h2 id="cmp-title">How it compares</h2>
        <div className="grid-cards">
          <ComparisonCard
            title={`Previous Black Friday (${formatDate(s.window_config.previous_event_date)})`}
            versus="the previous Black Friday price"
            cmp={s.previous_event}
            currency={currency}
            byId={byId}
            empty="No comparable price found for the previous Black Friday."
          />
          <ComparisonCard
            title="Lowest off-season price"
            subtitle={`${formatDate(s.window_config.offseason_start)} – ${formatDate(s.window_config.offseason_end)}`}
            versus="the lowest off-season price"
            cmp={s.offseason}
            currency={currency}
            byId={byId}
            empty="No comparable off-season price found."
          />
          <ComparisonCard
            title="Historical minimum"
            subtitle="Lowest comparable price we found"
            versus="the historical minimum"
            cmp={s.overall}
            currency={currency}
            byId={byId}
            empty="No comparable historical price found."
          />
          <ComparisonCard
            title="Same-retailer minimum"
            subtitle={s.assessed?.retailer ? `At ${s.assessed.retailer}` : undefined}
            versus="the same-retailer minimum"
            cmp={s.same_retailer}
            currency={currency}
            byId={byId}
            empty="No earlier comparable price found at the same retailer."
          />
        </div>
      </section>

      <section className="card" aria-labelledby="promo-title">
          <h2 id="promo-title">The retailer's claims</h2>
          {s.advertised_discount ? (
            <div className="claim">
              <p>
                <strong>Advertised discount: {formatPercentAbs(s.advertised_discount.percent)}</strong> off a stated reference price of{' '}
                {formatMoney(s.advertised_discount.reference_minor, currency)}.
              </p>
              {s.advertised_discount.note && <p className="small">{s.advertised_discount.note}</p>}
              <p className="small muted">This is what the retailer says. It is not a verified saving.</p>
            </div>
          ) : (
            <p className="muted">No advertised discount or reference price was found.</p>
          )}
          <PromotionExpiryView p={s.promotion_expiry} />
      </section>

      {pricedLeads.length > 0 && (
        <section aria-labelledby="seen-title" className="stack-sm">
          <h2 id="seen-title">Other prices we saw (not verified)</h2>
          <p className="hint">
            These prices appeared in search results or on pages we could not fully check (for example, the retailer blocked our research tool). They are shown for
            your information only and are <strong>not used</strong> in the verdict. Check them at the source.
          </p>
          <LeadPriceTable leads={pricedLeads} />
        </section>
      )}

      <section className="card" aria-labelledby="chart-title">
        <h2 id="chart-title">Verified prices over time</h2>
        <PriceChart snapshot={s} />
      </section>

      <CoverageView s={s} />

      <section aria-labelledby="evidence-title" className="stack-sm">
        <h2 id="evidence-title">Evidence</h2>
        <p className="hint">Every dated price we found, including ones we could not compare. Sources open in a new tab.</p>
        <ObservationTable rows={s.observations} caption="Historical price evidence" emptyText="No dated historical prices were found." />
      </section>

      <section aria-labelledby="alts-title" className="stack-sm">
        <h2 id="alts-title">Current alternatives</h2>
        <ObservationTable rows={s.current_alternatives} caption="Current offers elsewhere" emptyText="No other current offers were found." />
      </section>

      <section className="card" aria-labelledby="leads-title">
        <h2 id="leads-title">Other research leads (not verified, not used in calculations)</h2>
        {textLeads.length === 0 ? (
          <p className="muted">No other leads were recorded.</p>
        ) : (
          <ul className="leads">
            {textLeads.map((l, i) => {
              const href = safeHref(l.source_url);
              return (
                <li key={i}>
                  <p>{l.description}</p>
                  <p className="small muted">Why it wasn't used: {l.reason}</p>
                  {href && <ExternalLink href={href}>{hostOf(href)}</ExternalLink>}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="card" aria-labelledby="limits-title">
        <h2 id="limits-title">Limitations</h2>
        {s.limitations.length === 0 ? (
          <p className="muted">No specific limitations were recorded for this report.</p>
        ) : (
          <ul className="bullets">
            {s.limitations.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        )}
      </section>

      <footer className="research-meta small muted">
        <p>
          Research: {s.research.searches} search{s.research.searches === 1 ? '' : 'es'}, {s.research.fetches} page fetch
          {s.research.fetches === 1 ? '' : 'es'}, {formatDuration(s.research.duration_ms)}; cache hit: {s.research.cache_hit ? 'yes' : 'no'}; model:{' '}
          {s.research.model}.
        </p>
        <p>
          Generated {formatLocalDateTime(s.generated_at)} (your time) · calculation {s.calculation_version} · window {s.window_config.edition} ·
          market timezone {s.market.timezone}
        </p>
      </footer>

      <div className="actions">
        <button type="button" className="btn btn-primary" onClick={onNewCheck}>
          Check another product
        </button>
      </div>
    </article>
  );
}

function hostOf(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./, '');
  } catch {
    return href;
  }
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
      <span className="visually-hidden"> (opens in a new tab)</span>
    </a>
  );
}

function ProductFacts({ product }: { product: ReportSnapshot['product'] }) {
  const facts: [string, string][] = [];
  if (product.brand) facts.push(['Brand', product.brand]);
  if (product.model) facts.push(['Model', product.model]);
  if (product.variant) facts.push(['Variant', product.variant]);
  if (product.gtin) facts.push(['Barcode', product.gtin]);
  facts.push(['Condition', product.condition]);
  return (
    <dl className="facts">
      {facts.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function verifiedText(a: AssessedOffer): string {
  switch (a.verified_match) {
    case 'matches':
      return 'A retailer listing confirmed this price.';
    case 'differs':
      return a.verified_amount_minor !== null
        ? `A retailer listing showed a different price: ${formatMoney(a.verified_amount_minor, a.currency)}.`
        : 'A retailer listing showed a different price.';
    case 'not_found':
      return 'We could not find a retailer listing to confirm this price.';
    case 'not_checked':
      return 'This price was not checked against a retailer listing.';
  }
}

function AssessedCard({ assessed: a }: { assessed: AssessedOffer | null }) {
  if (!a) {
    return (
      <section className="card" aria-labelledby="assessed-title">
        <h2 id="assessed-title">Assessed price</h2>
        <p className="muted">We could not establish a current price for this product, so there is nothing to compare against.</p>
      </section>
    );
  }
  const href = safeHref(a.source_url);
  return (
    <section className="card assessed" aria-labelledby="assessed-title">
      <div className="assessed-top">
        <h2 id="assessed-title">Assessed price</h2>
        <span className={`badge ${a.basis === 'verified_offer' ? 'badge-verified' : 'badge-user'}`}>
          {a.basis === 'verified_offer' ? 'Verified offer' : 'You entered'}
        </span>
      </div>
      <p className="amount">{formatMoney(a.amount_minor, a.currency)}</p>
      <p className={`verify verify-${a.verified_match}`}>{verifiedText(a)}</p>
      <dl className="facts">
        <div>
          <dt>Retailer</dt>
          <dd>{a.retailer ?? 'Not specified'}</dd>
        </div>
        <div>
          <dt>Availability</dt>
          <dd>{AVAILABILITY_LABELS[a.availability]}</dd>
        </div>
        <div>
          <dt>Currency</dt>
          <dd>
            {a.currency} · {TAX_LABELS[a.tax_basis]}
          </dd>
        </div>
        <div>
          <dt>As of</dt>
          <dd>
            {formatDate(a.as_of_local_date)} <span className="muted">(checked {formatLocalDateTime(a.as_of)} your time)</span>
          </dd>
        </div>
        {href && (
          <div>
            <dt>Source</dt>
            <dd>
              <ExternalLink href={href}>{hostOf(href)}</ExternalLink>
            </dd>
          </div>
        )}
      </dl>
    </section>
  );
}

function ComparisonCard({
  title,
  subtitle,
  versus,
  cmp,
  currency,
  byId,
  empty,
}: {
  title: string;
  subtitle?: string | undefined;
  versus: string;
  cmp: Comparison | null;
  currency: string;
  byId: Map<string, ReportObservation>;
  empty: string;
}) {
  const obs = cmp ? byId.get(cmp.observation_id) : undefined;
  const href = safeHref(obs?.source_url);
  let diff: { cls: string; text: string } | null = null;
  if (cmp) {
    if (cmp.difference_minor === 0) diff = { cls: 'diff-same', text: `The assessed price is the same as ${versus}.` };
    else if (cmp.difference_minor < 0)
      diff = {
        cls: 'diff-below',
        text: `The assessed price is ${formatPercentAbs(cmp.percent)} below ${versus} (${formatMoney(Math.abs(cmp.difference_minor), currency)} less).`,
      };
    else
      diff = {
        cls: 'diff-above',
        text: `The assessed price is ${formatPercentAbs(cmp.percent)} above ${versus} (${formatMoney(cmp.difference_minor, currency)} more).`,
      };
  }
  return (
    <section className="card cmp">
      <h3>{title}</h3>
      {subtitle && <p className="small muted">{subtitle}</p>}
      {cmp ? (
        <>
          <p className="amount amount-sm">{formatMoney(cmp.minimum_minor, currency)}</p>
          <p className="small">on {formatComparisonDate(cmp.date)}</p>
          {diff && <p className={`diff ${diff.cls}`}>{diff.text}</p>}
          {obs && (
            <p className="small muted">
              {obs.retailer ? `${obs.retailer} · ` : ''}
              {href ? <ExternalLink href={href}>{obs.source_domain}</ExternalLink> : obs.source_domain}
            </p>
          )}
        </>
      ) : (
        <p className="muted empty">{empty}</p>
      )}
    </section>
  );
}

function PromotionExpiryView({ p }: { p: ReportSnapshot['promotion_expiry'] }) {
  const href = safeHref(p.source_url);
  let text: string;
  switch (p.status) {
    case 'documented':
      text = p.ends_local ? `The promotion is documented to end ${formatWallClock(p.ends_local)} (market local time).` : 'The promotion has a documented end date.';
      break;
    case 'claimed_unspecified':
      text = 'The retailer suggests the offer is time-limited but gives no end date.';
      break;
    case 'conflicting':
      text = 'Sources disagree about when this promotion ends.';
      break;
    case 'not_found':
      text = 'We found no stated end date for this promotion.';
      break;
  }
  return (
    <div className="claim">
      <p>
        <strong>Promotion end: </strong>
        {text}
      </p>
      {p.note && <p className="small">{p.note}</p>}
      {href && (
        <p className="small">
          Source: <ExternalLink href={href}>{hostOf(href)}</ExternalLink>
        </p>
      )}
    </div>
  );
}

function CoverageView({ s }: { s: ReportSnapshot }) {
  const c = s.coverage;
  return (
    <section className="card" aria-labelledby="coverage-title">
      <h2 id="coverage-title">Evidence coverage</h2>
      <dl className="facts facts-wide">
        <div>
          <dt>Comparable observations</dt>
          <dd>
            {c.comparable_observations} ({c.distinct_dates} distinct date{c.distinct_dates === 1 ? '' : 's'})
          </dd>
        </div>
        <div>
          <dt>Date range</dt>
          <dd>{c.date_range ? `${formatDateRange(c.date_range.start, c.date_range.end)} (${c.span_days} days)` : 'None'}</dd>
        </div>
        <div>
          <dt>Independent sources</dt>
          <dd>{c.distinct_origins}</dd>
        </div>
        <div>
          <dt>Months with evidence</dt>
          <dd>{c.months_represented.length}</dd>
        </div>
        <div>
          <dt>Months without evidence</dt>
          <dd>{c.months_missing.length === 0 ? 'None' : c.months_missing.map(formatMonth).join(', ')}</dd>
        </div>
      </dl>
      <div className={`threshold ${c.threshold_met ? 'threshold-met' : 'threshold-unmet'}`}>
        <p>
          <strong>{c.threshold_met ? 'Coverage rule met.' : 'Coverage rule not met.'}</strong> {c.threshold_rule}
        </p>
      </div>
    </section>
  );
}

function observationDate(o: ReportObservation): string {
  if (o.date_precision === 'month') return `${formatMonth(o.date_start)} (month only)`;
  return formatDateRange(o.date_start, o.date_end);
}

function ObservationTable({ rows, caption, emptyText }: { rows: ReportObservation[]; caption: string; emptyText: string }) {
  if (rows.length === 0) return <p className="card muted empty">{emptyText}</p>;
  const sorted = [...rows].sort((a, b) => (a.date_start < b.date_start ? -1 : a.date_start > b.date_start ? 1 : a.amount_minor - b.amount_minor));
  return (
    <div className="table-wrap">
      <table className="evidence">
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Price</th>
            <th scope="col">Retailer</th>
            <th scope="col">Window</th>
            <th scope="col">Comparable</th>
            <th scope="col">Source</th>
            <th scope="col">Excerpt</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((o) => {
            const href = safeHref(o.source_url);
            const elig = ELIGIBILITY_LABELS[o.eligibility];
            return (
              <tr key={o.id} className={o.comparable ? 'row-comparable' : 'row-noncomparable'}>
                <td data-label="Date">{observationDate(o)}</td>
                <td data-label="Price">
                  <span className="nowrap">{formatMoney(o.amount_minor, o.currency)}</span>
                  <span className="cell-note">
                    {TAX_LABELS[o.tax_basis]}
                    {elig ? ` · ${elig}` : ''}
                    {o.shipping_minor === null ? ' · delivery unknown' : o.shipping_minor === 0 ? ' · free delivery' : ` · + ${formatMoney(o.shipping_minor, o.currency)} delivery`}
                  </span>
                </td>
                <td data-label="Retailer">{o.retailer ?? <span className="muted">Unknown</span>}</td>
                <td data-label="Window">{WINDOW_LABELS[o.window]}</td>
                <td data-label="Comparable">
                  <span className={`badge ${o.comparable ? 'badge-yes' : 'badge-no'}`}>{o.comparable ? 'Yes' : 'No'}</span>
                  {o.comparability_notes.length > 0 && (
                    <ul className="cell-notes">
                      {o.comparability_notes.map((n, i) => (
                        <li key={i}>{n}</li>
                      ))}
                    </ul>
                  )}
                </td>
                <td data-label="Source">
                  <span className="cell-source">{o.source_name}</span>
                  {href ? <ExternalLink href={href}>{o.source_domain}</ExternalLink> : <span>{o.source_domain}</span>}
                  <span className="cell-note">Retrieved {formatLocalDateTime(o.retrieved_at)}</span>
                </td>
                <td data-label="Excerpt">{o.excerpt ? <q className="excerpt">{o.excerpt}</q> : <span className="muted">None</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PriceSummary({ verified, leads, currency }: { verified: number; leads: { amount_minor: number }[]; currency: string }) {
  if (verified === 0 && leads.length === 0) return null;
  const amounts = leads.map((l) => l.amount_minor);
  const lo = amounts.length ? Math.min(...amounts) : 0;
  const hi = amounts.length ? Math.max(...amounts) : 0;
  return (
    <p className="price-summary">
      <strong>{verified}</strong> verified price{verified === 1 ? '' : 's'}
      {leads.length > 0 && (
        <>
          {' · '}
          <strong>{leads.length}</strong> unverified price{leads.length === 1 ? '' : 's'} seen
          {' ('}
          {lo === hi ? formatMoney(lo, currency) : `${formatMoney(lo, currency)} – ${formatMoney(hi, currency)}`}
          {') — listed below, not used in the verdict.'}
        </>
      )}
    </p>
  );
}

function LeadPriceTable({ leads }: { leads: (ReportLead & { amount_minor: number })[] }) {
  const sorted = [...leads].sort((a, b) => a.amount_minor - b.amount_minor);
  return (
    <div className="table-wrap">
      <table className="evidence leads-table">
        <caption className="visually-hidden">Unverified prices seen during research, lowest first</caption>
        <thead>
          <tr>
            <th scope="col">Price</th>
            <th scope="col">Retailer</th>
            <th scope="col">Date stated</th>
            <th scope="col">Source</th>
            <th scope="col">Why not verified</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((l, i) => {
            const href = safeHref(l.source_url);
            return (
              <tr key={i} className="row-noncomparable">
                <td data-label="Price">
                  <span className="nowrap">{formatMoney(l.amount_minor, l.currency ?? '')}</span>
                  <span className="badge badge-no">Unverified</span>
                </td>
                <td data-label="Retailer">{l.retailer ?? <span className="muted">Unknown</span>}</td>
                <td data-label="Date stated">{l.date ?? <span className="muted">Not stated</span>}</td>
                <td data-label="Source">{href ? <ExternalLink href={href}>{hostOf(href)}</ExternalLink> : <span className="muted">No link</span>}</td>
                <td data-label="Why not verified">
                  <span className="cell-note">{l.reason}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
