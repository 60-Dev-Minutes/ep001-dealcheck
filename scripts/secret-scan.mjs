// Fails if staged/tracked files (or the working tree when not in git) contain likely secrets
// or private material. Run before every commit/push: `npm run secret-scan`.
import { execSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const PATTERNS = [
  [/sk-ant-[A-Za-z0-9_-]{10,}/, 'Anthropic API key'],
  [/sk-ant-admin[A-Za-z0-9_-]*/, 'Anthropic admin key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key'],
  [/\b(?:CLOUDFLARE_API_TOKEN|ANTHROPIC_API_KEY|TURNSTILE_SECRET_KEY|QUOTA_HMAC_SECRET|SESSION_SECRET)\s*[=:]\s*["']?(?!replace|<|\$|test-|1x0{20}|\.\.\.|\s*$)[A-Za-z0-9_\-]{16,}/, 'secret assignment'],
  [/\bBearer\s+[A-Za-z0-9_\-.]{30,}/, 'bearer token'],
  [/053db0fc0517bf1427926531a4d1bf7a/, 'Cloudflare account ID (keep in private runbook)'],
  [/Internal implementation specification|Confidential engineering brief/i, 'internal specification text'],
];
const FORBIDDEN_PATHS = [/^private\//, /(^|\/)\.dev\.vars$/, /(^|\/)\.env$/, /EXPERIMENT-LOG/i, /RUNBOOK/i];

let files;
try {
  files = execSync('git ls-files --cached --others --exclude-standard', { encoding: 'utf8' }).split('\n').filter(Boolean);
} catch {
  console.error('not a git repository');
  process.exit(2);
}
let bad = 0;
for (const f of files) {
  if (f === 'scripts/secret-scan.mjs') continue;
  if (FORBIDDEN_PATHS.some((p) => p.test(f))) { console.error(`FORBIDDEN PATH: ${f}`); bad++; continue; }
  let text;
  try {
    if (statSync(f).size > 2_000_000) continue;
    text = readFileSync(f, 'utf8');
  } catch { continue; }
  for (const [re, label] of PATTERNS) if (re.test(text)) { console.error(`${label}: ${f}`); bad++; }
}
if (bad) { console.error(`secret-scan: ${bad} problem(s)`); process.exit(1); }
console.log(`secret-scan: ${files.length} files clean`);
