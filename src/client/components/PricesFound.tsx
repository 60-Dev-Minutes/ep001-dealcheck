import type { ReportLead, ReportObservation, ReportSnapshot } from '../../shared/types';
import { formatMoney } from '../../shared/money';
import { formatDateRange, formatLocalDateTime, safeHref } from '../util';

// One place for every price DealCheck saw: verified (with proof) and unverified (with the reason),
// newest first. Only verified prices are used in the verdict; the badge makes that explicit.

type Row =
  | { kind: 'verified'; key: string; date: string | null; sortDate: string; amount: number; currency: string; where: string; current: boolean; o: ReportObservation }
  | { kind: 'unverified'; key: string; date: string | null; sortDate: string; amount: number; currency: string; where: string; l: ReportLead };

function host(u: string | null): string {
  if (!u) return '';
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Internet Archive calendar of saved copies for a source page ("historical links"). */
export function archiveHistoryUrl(u: string | null): string | null {
  const href = safeHref(u);
  if (!href || host(href).endsWith('archive.org')) return null;
  return `https://web.archive.org/web/*/${href.split('#')[0]}`;
}

const DIFFERENT_RE = /\b(different|another|other) (product|variant|model|sku|configuration|bundle)|refurb|not the .{0,30}(bundle|variant|model)|second-hand|used condition/i;

/** Leads for another model/variant are not prices for this product (older reports: wording fallback). */
export function isDifferentProduct(l: ReportLead): boolean {
  return l.product_match === 'different' || (l.product_match === undefined && DIFFERENT_RE.test(l.reason));
}

export function buildRows(s: ReportSnapshot): Row[] {
  const rows: Row[] = [];
  for (const o of s.observations) {
    rows.push({ kind: 'verified', key: `o-${o.id}`, date: formatDateRange(o.date_start, o.date_end), sortDate: o.date_end, amount: o.amount_minor, currency: o.currency, where: o.retailer ?? o.source_domain, current: false, o });
  }
  for (const o of s.current_alternatives) {
    rows.push({ kind: 'verified', key: `c-${o.id}`, date: formatDateRange(o.date_start, o.date_end), sortDate: o.date_end, amount: o.amount_minor, currency: o.currency, where: o.retailer ?? o.source_domain, current: true, o });
  }
  s.leads.forEach((l, i) => {
    if (typeof l.amount_minor !== 'number' || l.currency !== s.market.currency || isDifferentProduct(l)) return;
    const d = l.date && /^\d{4}-\d{2}(-\d{2})?/.test(l.date) ? l.date : null;
    rows.push({ kind: 'unverified', key: `l-${i}`, date: d, sortDate: d ?? '', amount: l.amount_minor, currency: l.currency, where: l.retailer || host(l.source_url) || 'Unknown', l });
  });
  // Newest first; undated last; then cheapest first.
  return rows.sort((a, b) => (a.sortDate === b.sortDate ? a.amount - b.amount : !a.sortDate ? 1 : !b.sortDate ? -1 : a.sortDate < b.sortDate ? 1 : -1));
}

export function PricesFound({ s }: { s: ReportSnapshot }) {
  const rows = buildRows(s);
  if (rows.length === 0) {
    return (
      <section className="card" aria-labelledby="prices-title">
        <h2 id="prices-title">Prices found</h2>
        <p className="muted">We did not find any prices for this exact product in {s.market.name}.</p>
      </section>
    );
  }
  const verified = rows.filter((r) => r.kind === 'verified');
  const unverified = rows.filter((r) => r.kind === 'unverified');
  const lowV = verified.length ? verified.reduce((a, r) => (r.amount < a.amount ? r : a)) : null;
  // Prefer snippets that are for the exact product; fall back to uncertain ones.
  const exactU = unverified.filter((r) => r.kind === 'unverified' && r.l.product_match === 'exact');
  const poolU = exactU.length ? exactU : unverified;
  const lowU = poolU.length ? poolU.reduce((a, r) => (r.amount < a.amount ? r : a)) : null;
  const hidden = s.leads.filter((l) => typeof l.amount_minor === 'number' && isDifferentProduct(l)).length;
  return (
    <section className="stack-sm" aria-labelledby="prices-title">
      <h2 id="prices-title">Prices found</h2>
      <div className="price-cards">
        <div className={`price-card ${lowV ? 'price-card-verified' : 'price-card-empty'}`}>
          <p className="eyebrow">Lowest verified price</p>
          {lowV ? (
            <>
              <p className="big-price">{formatMoney(lowV.amount, lowV.currency)}</p>
              <p className="small">
                {lowV.where} · {lowV.date}
              </p>
            </>
          ) : (
            <p className="small muted">None we could prove yet.</p>
          )}
        </div>
        {lowU && (
          <div className="price-card price-card-unverified">
            <p className="eyebrow">Lowest price seen (not verified)</p>
            <p className="big-price">{formatMoney(lowU.amount, lowU.currency)}</p>
            <p className="small">
              {lowU.where}
              {lowU.date ? ` · ${lowU.date}` : ' · date not stated'}
            </p>
          </div>
        )}
      </div>
      <p className="hint">
        {verified.length} verified · {unverified.length} not verified{hidden ? ` · ${hidden} for other variants hidden` : ''}. Only verified prices count towards the verdict. Each source has an <em>archive history</em> link
        to its saved copies over time.
      </p>
      <ul className="price-rows">
        {rows.map((r) => (
          <li key={r.key} className={`price-row price-row-${r.kind}`}>
            <div className="price-row-main">
              <span className="price-row-amount">{formatMoney(r.amount, r.currency)}</span>
              <span className="price-row-where">{r.where}</span>
              <span className="price-row-date">{r.date ?? 'Date not stated'}</span>
              {r.kind === 'verified' ? (
                <span className="badge badge-yes">✓ Verified{r.current ? ' · current' : ''}</span>
              ) : (
                <span className="badge badge-no">{r.l.product_match === 'exact' ? 'Not verified' : 'Not verified · variant unsure'}</span>
              )}
            </div>
            {r.kind === 'verified' ? <VerifiedDetail o={r.o} /> : <UnverifiedDetail l={r.l} />}
          </li>
        ))}
      </ul>
    </section>
  );
}

function SourceLinks({ url, primaryLabel }: { url: string | null; primaryLabel: string }) {
  const href = safeHref(url);
  const hist = archiveHistoryUrl(url);
  if (!href && !hist) return null;
  return (
    <p className="price-row-links">
      {href && (
        <a href={href} target="_blank" rel="noopener noreferrer nofollow">
          {primaryLabel}
          <span className="visually-hidden"> (opens in a new tab)</span>
        </a>
      )}
      {hist && (
        <a href={hist} target="_blank" rel="noopener noreferrer nofollow">
          Archive history
          <span className="visually-hidden"> of this page (opens in a new tab)</span>
        </a>
      )}
    </p>
  );
}

function VerifiedDetail({ o }: { o: ReportObservation }) {
  const p = o.proof;
  const original = p?.kind === 'archived_page' ? o.source_url.replace(/^https:\/\/web\.archive\.org\/web\/\d+\//, '') : o.source_url;
  return (
    <details className="price-row-detail">
      <summary>How we verified this</summary>
      {o.excerpt && (
        <blockquote className="proof-quote">
          <q>{o.excerpt}</q>
        </blockquote>
      )}
      {p && (
        <ul className="proof-checks">
          {p.checks.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
      )}
      {o.comparability_notes.length > 0 && <p className="cell-note">{o.comparability_notes.join(' ')}</p>}
      <p className="cell-note">
        {p?.kind === 'archived_page' ? 'Captured by the Internet Archive' : 'Retrieved'} {formatLocalDateTime(p?.captured_at ?? o.retrieved_at)}
      </p>
      <SourceLinks url={p?.open_url ?? o.source_url} primaryLabel={p?.open_label ?? 'Open source'} />
      {p?.kind === 'archived_page' && <SourceLinks url={original} primaryLabel="Current page" />}
    </details>
  );
}

function UnverifiedDetail({ l }: { l: ReportLead }) {
  return (
    <div className="price-row-detail">
      <p className="cell-note">Why not verified: {l.reason}</p>
      <SourceLinks url={l.source_url} primaryLabel={host(l.source_url) ? `Source (${host(l.source_url)})` : 'Source'} />
    </div>
  );
}
