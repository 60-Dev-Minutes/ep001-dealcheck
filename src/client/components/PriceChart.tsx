import { useLayoutEffect, useRef, useState } from 'react';
import type { ReportObservation, ReportSnapshot } from '../../shared/types';
import { formatMoney } from '../../shared/money';
import { dayNumber, formatDate, formatDateRange, fromDayNumber } from '../util';

// Discrete observations only: dots for dated prices, short bars for known date ranges.
// No connecting lines, no interpolation, no trend.

const MONTH_TICK = new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' });
const YEAR_TICK = new Intl.DateTimeFormat('en-GB', { year: 'numeric', timeZone: 'UTC' });

interface Plotted {
  obs: ReportObservation;
  start: number;
  end: number;
}

function niceStep(range: number, target: number): number {
  const raw = range / Math.max(1, target);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return nice * pow;
}

function useWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(280, Math.round(el.clientWidth)));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

export function PriceChart({ snapshot }: { snapshot: ReportSnapshot }) {
  const { ref, width } = useWidth<HTMLDivElement>(640);
  const currency = snapshot.assessed?.currency ?? snapshot.market.currency;
  const bfDate = snapshot.window_config.previous_event_date;
  const asOf = snapshot.assessed?.as_of_local_date ?? snapshot.generated_at.slice(0, 10);

  const windowStart = dayNumber(bfDate);
  const windowEnd = Math.max(dayNumber(asOf), windowStart + 1);

  const plotted: Plotted[] = [];
  let outside = 0;
  for (const obs of snapshot.observations) {
    if (obs.currency !== currency) {
      outside += 1;
      continue;
    }
    const s = dayNumber(obs.date_start);
    const e = dayNumber(obs.date_end);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e < windowStart || s > windowEnd) {
      outside += 1;
      continue;
    }
    plotted.push({ obs, start: Math.max(s, windowStart), end: Math.min(e, windowEnd) });
  }

  const assessed = snapshot.assessed && snapshot.assessed.currency === currency ? snapshot.assessed.amount_minor : null;

  if (plotted.length === 0) {
    return (
      <div className="chart-empty">
        <p>
          No dated observations between {formatDate(bfDate)} and {formatDate(asOf)} to plot.
          {snapshot.observations.length > 0 ? ' Any observations found are listed in the evidence table below.' : ''}
        </p>
      </div>
    );
  }

  // ---------------------------------------------------------------- scales
  const narrow = width < 480;
  const height = narrow ? 260 : 320;
  const m = { top: 28, right: narrow ? 12 : 20, bottom: 40, left: narrow ? 52 : 68 };
  const innerW = width - m.left - m.right;
  const innerH = height - m.top - m.bottom;

  const span = windowEnd - windowStart;
  const padDays = Math.max(3, Math.round(span * 0.03));
  const x0 = windowStart - padDays;
  const x1 = windowEnd + padDays;
  const x = (day: number) => m.left + ((day - x0) / (x1 - x0)) * innerW;

  const amounts = plotted.map((p) => p.obs.amount_minor);
  if (assessed !== null) amounts.push(assessed);
  let lo = Math.min(...amounts);
  let hi = Math.max(...amounts);
  if (hi === lo) {
    lo = lo * 0.9;
    hi = hi * 1.1 || 100;
  }
  const step = niceStep(hi - lo, narrow ? 4 : 5);
  const y0 = Math.max(0, Math.floor((lo - step * 0.5) / step) * step);
  const y1 = Math.ceil((hi + step * 0.5) / step) * step;
  const y = (v: number) => m.top + innerH - ((v - y0) / (y1 - y0)) * innerH;

  const yTicks: number[] = [];
  for (let v = y0; v <= y1 + 1e-6; v += step) yTicks.push(Math.round(v));
  const decimals = step < 100 ? 2 : 0;
  const yFmt = new Intl.NumberFormat('en-NZ', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });

  // Month ticks at the first of each month, thinned to fit.
  const months: number[] = [];
  const first = fromDayNumber(x0);
  let cursor = Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 1);
  while (cursor / 86_400_000 <= x1) {
    months.push(Math.round(cursor / 86_400_000));
    const d = new Date(cursor);
    cursor = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  }
  const maxTicks = narrow ? 4 : 7;
  const every = Math.max(1, Math.ceil(months.length / maxTicks));
  const xTicks = months.filter((_, i) => i % every === 0);

  // ---------------------------------------------------------------- summary for assistive tech
  const comparable = plotted.filter((p) => p.obs.comparable);
  const lowest = plotted.reduce((a, p) => (p.obs.amount_minor < a.obs.amount_minor ? p : a), plotted[0]!);
  const summary = [
    `Scatter plot of ${plotted.length} price observation${plotted.length === 1 ? '' : 's'} (${comparable.length} comparable) between ${formatDate(bfDate)} and ${formatDate(asOf)}.`,
    `Lowest plotted: ${formatMoney(lowest.obs.amount_minor, currency)} on ${formatDateRange(lowest.obs.date_start, lowest.obs.date_end)}.`,
    assessed !== null ? `Assessed price: ${formatMoney(assessed, currency)}.` : 'No assessed price.',
    `Previous Black Friday: ${formatDate(bfDate)}.`,
    outside > 0 ? `${outside} observation${outside === 1 ? ' is' : 's are'} outside this window or in another currency and listed in the table only.` : '',
    'The evidence table below lists every observation.',
  ]
    .filter(Boolean)
    .join(' ');

  const bfX = x(windowStart);
  const plotRight = m.left + innerW;

  return (
    <figure className="chart">
      <div ref={ref} className="chart-frame">
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={summary} className="chart-svg">
          {/* grid + y axis */}
          {yTicks.map((v) => (
            <g key={`y${v}`}>
              <line className="chart-grid" x1={m.left} x2={plotRight} y1={y(v)} y2={y(v)} />
              <text className="chart-tick" x={m.left - 8} y={y(v)} textAnchor="end" dominantBaseline="middle">
                {yFmt.format(v / 100)}
              </text>
            </g>
          ))}
          <text className="chart-axis-title" x={m.left} y={14} textAnchor="start">
            Price ({currency})
          </text>

          {/* x axis */}
          <line className="chart-axis" x1={m.left} x2={plotRight} y1={m.top + innerH} y2={m.top + innerH} />
          {xTicks.map((d, i) => {
            const date = fromDayNumber(d);
            const showYear = i === 0 || date.getUTCMonth() === 0;
            return (
              <g key={`x${d}`}>
                <line className="chart-axis" x1={x(d)} x2={x(d)} y1={m.top + innerH} y2={m.top + innerH + 5} />
                <text className="chart-tick" x={x(d)} y={m.top + innerH + 18} textAnchor="middle">
                  {MONTH_TICK.format(date)}
                </text>
                {showYear && (
                  <text className="chart-tick chart-tick-year" x={x(d)} y={m.top + innerH + 32} textAnchor="middle">
                    {YEAR_TICK.format(date)}
                  </text>
                )}
              </g>
            );
          })}

          {/* previous Black Friday rule */}
          <line className="chart-bf" x1={bfX} x2={bfX} y1={m.top} y2={m.top + innerH} />
          <text className="chart-ref-label" x={bfX + 4} y={m.top + 10} textAnchor="start">
            {narrow ? 'Prev. Black Friday' : 'Previous Black Friday'}
          </text>

          {/* assessed price reference */}
          {assessed !== null && (
            <g>
              <line className="chart-assessed" x1={m.left} x2={plotRight} y1={y(assessed)} y2={y(assessed)} />
              <text className="chart-ref-label chart-assessed-label" x={plotRight - 4} y={y(assessed) - 6} textAnchor="end">
                Assessed price
              </text>
            </g>
          )}

          {/* observations */}
          {plotted.map(({ obs, start, end }) => {
            const cls = obs.comparable ? 'mark-comparable' : 'mark-noncomparable';
            const label = `${formatDateRange(obs.date_start, obs.date_end)}: ${formatMoney(obs.amount_minor, obs.currency)}${obs.retailer ? ` at ${obs.retailer}` : ''} (${obs.comparable ? 'comparable' : 'not comparable'})`;
            const cy = y(obs.amount_minor);
            if (end > start) {
              const xs = x(start);
              const xe = Math.max(x(end), xs + 4);
              return (
                <rect key={obs.id} className={`mark ${cls}`} x={xs} y={cy - 3} width={xe - xs} height={6} rx={3}>
                  <title>{label}</title>
                </rect>
              );
            }
            return (
              <circle key={obs.id} className={`mark ${cls}`} cx={x(start)} cy={cy} r={5}>
                <title>{label}</title>
              </circle>
            );
          })}
        </svg>
      </div>
      <figcaption>
        <ul className="legend">
          <li>
            <svg width="16" height="16" aria-hidden="true">
              <circle className="mark mark-comparable" cx="8" cy="8" r="5" />
            </svg>
            Comparable observation
          </li>
          <li>
            <svg width="16" height="16" aria-hidden="true">
              <circle className="mark mark-noncomparable" cx="8" cy="8" r="5" />
            </svg>
            Not comparable
          </li>
          <li>
            <svg width="22" height="16" aria-hidden="true">
              <rect className="mark mark-comparable" x="2" y="5" width="18" height="6" rx="3" />
            </svg>
            Price over a known date range
          </li>
          {assessed !== null && (
            <li>
              <svg width="22" height="16" aria-hidden="true">
                <line className="chart-assessed" x1="1" x2="21" y1="8" y2="8" />
              </svg>
              Assessed price
            </li>
          )}
          <li>
            <svg width="16" height="16" aria-hidden="true">
              <line className="chart-bf" x1="8" x2="8" y1="1" y2="15" />
            </svg>
            Previous Black Friday
          </li>
        </ul>
        <p className="hint">
          Each mark is one dated price we found; nothing is joined up or estimated between them.
          {outside > 0 ? ` ${outside} observation${outside === 1 ? ' is' : 's are'} outside this window and shown in the table only.` : ''}
        </p>
      </figcaption>
    </figure>
  );
}
