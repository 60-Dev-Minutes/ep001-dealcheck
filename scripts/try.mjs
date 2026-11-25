// One-off investigation against a DealCheck instance with Turnstile test keys (local dev only).
// Usage: node scripts/try.mjs <market> "<product>" [price] [baseUrl]
const [market, product, price, baseArg] = process.argv.slice(2);
const base = (baseArg ?? 'http://localhost:8787').replace(/\/$/, '');
let cookie = '';
async function call(path, body) {
  const res = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { origin: base, ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  return { status: res.status, json: await res.json().catch(() => null) };
}
await call('/api/quota');
const started = Date.now();
const c = await call('/api/investigations', { market, product, ...(price ? { price } : {}), idempotency_key: crypto.randomUUID().replace(/-/g, ''), turnstile_token: 'XXXX.DUMMY.TOKEN.XXXX' });
if (c.status !== 202) { console.error('not started', c.status, c.json); process.exit(1); }
let st;
for (;;) {
  await new Promise((r) => setTimeout(r, 2000));
  st = (await call(`/api/investigations/${c.json.id}`)).json;
  if (st.state === 'awaiting_clarification') { console.error('clarify →', st.clarification.candidates[0].label); await call(`/api/investigations/${c.json.id}/clarify`, { candidate_id: st.clarification.candidates[0].id }); }
  if (['complete', 'failed', 'cancelled'].includes(st.state)) break;
  if (Date.now() - started > 10 * 60_000) { console.error('gave up'); process.exit(1); }
}
console.error(`${st.state} in ${Math.round((Date.now() - started) / 1000)}s`, st.error ?? '');
if (st.report_id) console.log(JSON.stringify((await call(`/api/reports/${st.report_id}`)).json));
