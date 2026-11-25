// Owner-only query log from production D1 (authenticated via your Cloudflare token).
// Usage: node scripts/queries.mjs [limit] [--local]     Live view: npx wrangler tail dealcheck --format pretty
import { execFileSync } from 'node:child_process';

const limit = Math.min(Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 50), 1000);
const where = process.argv.includes('--local') ? '--local' : '--remote';
const sql = `SELECT i.created_at, i.market, json_extract(i.input_json,'$.product') AS product, json_extract(i.input_json,'$.price_minor') AS price_minor,
  i.state, i.error_code, json_extract(r.snapshot,'$.verdict') AS verdict, json_extract(r.snapshot,'$.product.label') AS identified_as,
  json_array_length(json_extract(r.snapshot,'$.observations')) AS verified, (SELECT COALESCE(SUM(cost_estimate),0) FROM provider_usage u WHERE u.job_id = i.id) AS cost_micro,
  CAST((julianday(i.updated_at) - julianday(i.created_at)) * 86400 AS INTEGER) AS secs
  FROM investigations i LEFT JOIN reports r ON r.investigation_id = i.id ORDER BY i.created_at DESC LIMIT ${limit}`;
const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', where, '--json', '--command', sql], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const rows = JSON.parse(out)[0].results;
const pad = (s, n) => String(s ?? '').slice(0, n).padEnd(n);
console.log(`${pad('UTC', 19)} ${pad('Mkt', 3)} ${pad('Product', 34)} ${pad('State', 9)} ${pad('Verdict', 22)} ${pad('Ver', 3)} ${pad('NZ$', 6)} ${pad('Secs', 4)} Identified as / error`);
for (const r of rows) {
  console.log(`${pad(r.created_at.replace('T', ' '), 19)} ${pad(r.market, 3)} ${pad(r.product, 34)} ${pad(r.state, 9)} ${pad(r.verdict ?? '', 22)} ${pad(r.verified ?? '', 3)} ${pad((r.cost_micro / 1e6).toFixed(3), 6)} ${pad(r.secs, 4)} ${r.error_code ?? r.identified_as ?? ''}`);
}
const total = rows.reduce((a, r) => a + r.cost_micro, 0);
console.log(`\n${rows.length} queries · estimated AI cost NZ$${(total / 1e6).toFixed(3)}`);
