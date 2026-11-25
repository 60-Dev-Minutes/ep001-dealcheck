// Runs the frozen benchmark against a running DealCheck instance (default: local `wrangler dev`
// configured with the real provider). Records raw outputs and timings; never edits the selection.
// Usage: node scripts/benchmark.mjs [baseUrl] [--only=1,2,3]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const base = (process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'http://localhost:8787').replace(/\/$/, '');
const only = (process.argv.find((a) => a.startsWith('--only=')) ?? '').slice(7).split(',').filter(Boolean).map(Number);
const bench = JSON.parse(readFileSync(new URL('../benchmark/products.v1.json', import.meta.url), 'utf8'));
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = new URL(`../benchmark/results/${runId}/`, import.meta.url);
mkdirSync(outDir, { recursive: true });

let cookie = '';
async function call(path, init = {}) {
  const headers = { ...(init.headers ?? {}), origin: base, ...(cookie ? { cookie } : {}) };
  if (init.body) headers['content-type'] = 'application/json';
  const res = await fetch(base + path, { ...init, headers });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, json, text };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
await call('/api/quota');
for (const p of bench.products) {
  if (only.length && !only.includes(p.n)) continue;
  const started = Date.now();
  const rec = { n: p.n, market: p.market, input: p.input, started_at: new Date(started).toISOString(), events: [] };
  const create = await call('/api/investigations', {
    method: 'POST',
    body: JSON.stringify({ market: p.market, product: p.input, ...(p.price ? { price: p.price } : {}), idempotency_key: `bench${runId.replace(/[^0-9]/g, '')}${p.n}`.slice(0, 64), turnstile_token: 'XXXX.DUMMY.TOKEN.XXXX' }),
  });
  rec.create = { status: create.status, body: create.json };
  if (create.status !== 202) { rec.outcome = 'not_started'; results.push(rec); console.log(p.n, 'not started', create.status, create.text); continue; }
  const id = create.json.id;
  let st = null;
  for (let delay = 1000; ; delay = Math.min(delay * 1.5, 5000)) {
    await sleep(delay);
    st = (await call(`/api/investigations/${id}`)).json;
    rec.events.push({ t: Date.now() - started, state: st?.state });
    if (st?.state === 'awaiting_clarification') {
      const cand = st.clarification.candidates[0];
      rec.clarification = { question: st.clarification.question, candidates: st.clarification.candidates, chosen: cand.id };
      await call(`/api/investigations/${id}/clarify`, { method: 'POST', body: JSON.stringify({ candidate_id: cand.id }) });
      continue;
    }
    if (['complete', 'failed', 'cancelled'].includes(st?.state)) break;
    if (Date.now() - started > 15 * 60_000) break;
  }
  rec.final_state = st?.state;
  rec.duration_ms = Date.now() - started;
  if (st?.state === 'complete') rec.report = (await call(`/api/reports/${st.report_id}`)).json;
  else rec.error = st?.error ?? null;
  writeFileSync(new URL(`${String(p.n).padStart(2, '0')}.json`, outDir), JSON.stringify(rec, null, 2));
  results.push(rec);
  const r = rec.report;
  console.log(`#${p.n} ${p.market} ${rec.final_state} ${Math.round(rec.duration_ms / 1000)}s verdict=${r?.verdict ?? '-'} obs=${r?.observations?.length ?? 0} verified-comparable=${r?.coverage?.comparable_observations ?? 0}`);
}
const done = results.filter((r) => r.final_state === 'complete');
const durations = done.map((r) => r.duration_ms).sort((a, b) => a - b);
const summary = {
  run_id: runId, base, attempted: results.length, completed: done.length,
  failed: results.filter((r) => r.final_state === 'failed').length,
  with_1plus_comparable: done.filter((r) => (r.report?.coverage?.comparable_observations ?? 0) >= 1).length,
  with_3plus_comparable: done.filter((r) => (r.report?.coverage?.comparable_observations ?? 0) >= 3).length,
  emitted_observations: done.reduce((a, r) => a + (r.report?.observations?.length ?? 0), 0),
  median_duration_ms: durations.length ? durations[Math.floor((durations.length - 1) / 2)] : null,
  verdicts: done.reduce((a, r) => ({ ...a, [r.report.verdict]: (a[r.report.verdict] ?? 0) + 1 }), {}),
  note: 'Cost per investigation: query provider_usage in D1 (see runbook). Accuracy and identity require independent manual review of the raw files.',
};
writeFileSync(new URL('summary.json', outDir), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
