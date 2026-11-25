import { useEffect, useState } from 'react';
import type { RecentCheck, Verdict } from '../../shared/types';
import { getRecent, isAbort } from '../api';

const COLLAPSED = 5;

const VERDICT_SHORT: Record<Verdict, string> = {
  history_only: 'Price history found',
  insufficient_evidence: 'Insufficient evidence',
  cheaper_before: 'Cheaper before',
  price_matched_before: 'Price matched before',
  lowest_observed: 'Lowest observed',
  limited_history: 'Limited history',
};

function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** Public, read-only list of recently completed checks (product name as identified, market, verdict). */
export function RecentChecks() {
  const [items, setItems] = useState<RecentCheck[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    const load = () =>
      getRecent(ctrl.signal)
        .then((r) => { setItems(r.recent); setFailed(false); setNow(Date.now()); })
        .catch((e) => { if (!isAbort(e)) setFailed(true); });
    void load();
    const t = window.setInterval(load, 60_000);
    return () => { ctrl.abort(); window.clearInterval(t); };
  }, []);

  return (
    <aside className="recent card" aria-labelledby="recent-title">
      <h2 id="recent-title">Recently checked</h2>
      {items === null && !failed && <p className="muted small">Loading…</p>}
      {failed && items === null && <p className="muted small">Could not load recent checks.</p>}
      {items !== null && items.length === 0 && <p className="muted small">No completed checks yet. Yours could be the first.</p>}
      {items !== null && items.length > 0 && (
        <ol className="recent-list">
          {(expanded ? items : items.slice(0, COLLAPSED)).map((r, i) => (
            <li key={`${r.finished_at}-${i}`} className="recent-item">
              <span className="recent-product">{r.product}</span>
              <span className="recent-meta">
                <span className="recent-market">{r.market}</span>
                <span className={`recent-verdict recent-${r.verdict}`}>{VERDICT_SHORT[r.verdict]}</span>
                <time dateTime={r.finished_at}>{ago(r.finished_at, now)}</time>
              </span>
            </li>
          ))}
        </ol>
      )}
      {items !== null && items.length > COLLAPSED && (
        <button type="button" className="btn-link" aria-expanded={expanded} onClick={() => setExpanded((e) => !e)}>
          {expanded ? 'Show fewer' : `Show all ${items.length}`}
        </button>
      )}
      <p className="small muted">Product names as identified by DealCheck. Reports stay private.</p>
    </aside>
  );
}
