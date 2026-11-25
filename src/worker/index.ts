import { Hono } from 'hono';
import { MARKETS } from '../shared/markets';
import type { Clarification, InvestigationStatus, MarketInfo, QuotaInfo } from '../shared/types';
import { STAGE_LABELS, TERMINAL_STATES } from '../shared/types';
import { admit, budgetOpen, dayKeyFor, quotaView } from './admission';
import { readConfig, type Env } from './env';
import { apiError, json, sameOrigin, withSecurityHeaders } from './http';
import {
  networkBucket,
  quotaDigest,
  randomToken,
  readSessionCookie,
  SESSION_TTL_DAYS,
  sessionCookieHeader,
  sessionDigest,
  trustedClientAddress,
} from './identity';
import { getJob, logQuerySubmitted, nowIso, setState, stopJob, type JobInput, type JobRow } from './pipeline';
import { worstCaseJobCost } from './pricing';
import { reconcile, terminate } from './reconcile';
import { verifyTurnstile } from './turnstile';
import { CreateBody, validateCreate } from './validation';
import { JOB_RUNTIME_MS } from './workflow';

export { InvestigationWorkflow } from './workflow';

type Vars = { session: string | null; newSessionToken: string | null };
const app = new Hono<{ Bindings: Env; Variables: Vars }>();

const MAX_BODY = 8 * 1024;

// ------------------------------------------------------------------ session receipts

async function ensureSession(c: { env: Env; req: { raw: Request }; set: (k: 'session' | 'newSessionToken', v: string | null) => void }, create: boolean): Promise<string | null> {
  const secret = c.env.SESSION_SECRET;
  if (!secret) return null;
  const token = readSessionCookie(c.req.raw);
  const now = nowIso();
  if (token) {
    const digest = await sessionDigest(secret, token);
    const row = await c.env.DB.prepare(`SELECT expires_at FROM sessions WHERE digest = ?1`).bind(digest).first<{ expires_at: string }>();
    if (row && row.expires_at > now) {
      await c.env.DB.prepare(`UPDATE sessions SET last_seen = ?2 WHERE digest = ?1`).bind(digest, now).run();
      c.set('session', digest);
      return digest;
    }
  }
  if (!create) return null;
  const fresh = randomToken(32);
  const digest = await sessionDigest(secret, fresh);
  const expires = new Date(Date.now() + SESSION_TTL_DAYS * 86400_000).toISOString();
  await c.env.DB.prepare(`INSERT INTO sessions (digest, created_at, expires_at, last_seen) VALUES (?1, ?2, ?3, ?2)`).bind(digest, now, expires).run();
  c.set('session', digest);
  c.set('newSessionToken', fresh);
  return digest;
}

async function networkDigest(env: Env, req: Request): Promise<string | null> {
  const cfg = readConfig(env);
  if (!env.QUOTA_HMAC_SECRET) return null;
  const addr = trustedClientAddress(req, !cfg.production);
  if (!addr) return null;
  const bucket = networkBucket(addr);
  if (!bucket) return null;
  return quotaDigest(env.QUOTA_HMAC_SECRET, cfg.quotaKeyVersion, bucket);
}

app.use('/api/*', async (c, next) => {
  c.set('session', null);
  c.set('newSessionToken', null);
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    if (!sameOrigin(c.req.raw)) return apiError('FORBIDDEN_ORIGIN', 'Cross-origin requests are not allowed.', 403);
    if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) return apiError('INVALID_INPUT', 'Expected JSON.', 400);
  }
  await next();
  const token = c.get('newSessionToken');
  if (token) c.res.headers.append('Set-Cookie', sessionCookieHeader(token, new URL(c.req.url).protocol === 'https:'));
});

// ------------------------------------------------------------------ routes

app.get('/health', () => json({ status: 'ok' }));

app.get('/api/markets', () => {
  const markets: MarketInfo[] = MARKETS.map((m) => ({ code: m.code, name: m.name, currency: m.currency }));
  return json({ markets }, 200, 'public, max-age=300');
});

app.get('/api/quota', async (c) => {
  const cfg = readConfig(c.env);
  await ensureSession(c, true);
  const digest = await networkDigest(c.env, c.req.raw);
  const view = digest ? await quotaView(c.env.DB, digest, cfg.quotaTotal) : { used: 0, remaining: 0 };
  const cost = worstCaseJobCost(cfg.model);
  const open = cfg.researchEnabled && cost !== null && (await budgetOpen(c.env.DB, dayKeyFor(new Date(), cfg.budgetTimezone), cfg.dailyCapMicroNzd, cost));
  const body: QuotaInfo = {
    remaining: view.remaining,
    total: cfg.quotaTotal,
    research_available: open,
    paused_reason: open ? null : cfg.researchEnabled ? 'budget' : 'disabled',
    turnstile_site_key: c.env.TURNSTILE_SITE_KEY || null,
  };
  return json(body);
});

app.post('/api/investigations', async (c) => {
  const cfg = readConfig(c.env);
  const env = c.env;
  const digest = await networkDigest(env, c.req.raw);
  if (!digest) return apiError('INTERNAL', 'Service is not configured.', 503, false);
  const rl = await env.RL_ADMISSION.limit({ key: digest });
  if (!rl.success) return apiError('RATE_LIMITED', 'Too many requests. Please wait a minute.', 429);

  const raw = await c.req.text();
  if (raw.length > MAX_BODY) return apiError('INVALID_INPUT', 'Request too large.', 400);
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(raw);
  } catch {
    return invalid(env, digest, 'Malformed request.');
  }
  const body = CreateBody.safeParse(parsedBody);
  if (!body.success) return invalid(env, digest, 'Some fields are missing or invalid.');
  const v = validateCreate(body.data);
  if (!v.ok) {
    await env.RL_INVALID.limit({ key: digest });
    return apiError(v.error.code, v.error.message, v.status, false);
  }

  const session = await ensureSession(c, true);
  if (!session) return apiError('INTERNAL', 'Service is not configured.', 503, false);

  // Idempotent retry: same session + key returns the existing job without new work or charges.
  const existing = await env.DB.prepare(`SELECT id, state FROM investigations WHERE session_digest = ?1 AND idempotency_key = ?2`).bind(session, body.data.idempotency_key).first<{ id: string; state: string }>();
  if (existing) return json({ id: existing.id, state: existing.state }, 202);

  if (!cfg.researchEnabled) return apiError('BUDGET_PAUSED', 'Research is currently paused. Existing reports remain available.', 503, false);
  const cost = worstCaseJobCost(cfg.model);
  if (cost === null || cfg.dailyCapMicroNzd <= 0) return apiError('BUDGET_PAUSED', 'Research is currently paused.', 503, false);

  const human = await verifyTurnstile(env.TURNSTILE_SECRET_KEY, body.data.turnstile_token);
  if (!human) return apiError('TURNSTILE_FAILED', 'Verification failed. Please try again.', 403);

  const now = new Date();
  const jobId = `inv_${randomToken(18)}`;
  const result = await admit(env.DB, {
    jobId, sessionDigest: session, quotaDigest: digest, quotaKeyVersion: cfg.quotaKeyVersion, idempotencyKey: body.data.idempotency_key,
    market: v.market.code, inputJson: JSON.stringify(v.input satisfies JobInput), costReserved: cost,
    dayKey: dayKeyFor(now, cfg.budgetTimezone), dailyCap: cfg.dailyCapMicroNzd, quotaTotal: cfg.quotaTotal,
    globalConcurrency: cfg.globalConcurrency, now: now.toISOString(), deadlineAt: new Date(now.getTime() + JOB_RUNTIME_MS).toISOString(),
  });
  switch (result.status) {
    case 'duplicate':
      return json({ id: result.jobId, state: 'queued' }, 202);
    case 'quota_exhausted':
      return apiError('QUOTA_EXHAUSTED', 'This network has used its free investigations for the pilot. The allowance is shared by everyone on the same network.', 429, false);
    case 'busy_network':
      return apiError('BUSY', 'An investigation from this network is already running. Please wait for it to finish.', 429);
    case 'busy_global':
      return apiError('BUSY', 'DealCheck is busy right now. Please try again in a minute.', 503);
    case 'budget_paused':
    case 'paused':
      return apiError('BUDGET_PAUSED', "Today's research budget has been reached. Please try again after midnight New Zealand time.", 503, false);
    case 'admitted':
      break;
  }
  await budgetAlert(env, dayKeyFor(now, cfg.budgetTimezone));
  logQuerySubmitted(jobId, v.input);
  try {
    await env.INVESTIGATION.create({ id: jobId, params: { jobId } });
  } catch {
    await stopJob(env, jobId, 'failed', 'PROVIDER_UNAVAILABLE');
    return apiError('PROVIDER_UNAVAILABLE', 'Could not start the investigation. No allowance was used. Please try again.', 503);
  }
  return json({ id: jobId, state: 'queued' }, 202);
});

/** Operational alert (logs only; no identity): budget at >= 80% of the daily cap. */
async function budgetAlert(env: Env, dayKey: string): Promise<void> {
  const b = await env.DB.prepare(`SELECT spent_estimate, outstanding_reserved, cap FROM daily_budget WHERE day_key = ?1`).bind(dayKey).first<{ spent_estimate: number; outstanding_reserved: number; cap: number }>();
  if (b && b.cap > 0 && (b.spent_estimate + b.outstanding_reserved) * 5 >= b.cap * 4) {
    console.warn(JSON.stringify({ event: 'budget_near_cap', day: dayKey, spent_micro_nzd: b.spent_estimate, outstanding_micro_nzd: b.outstanding_reserved, cap_micro_nzd: b.cap }));
  }
}

async function invalid(env: Env, digest: string, message: string): Promise<Response> {
  const rl = await env.RL_INVALID.limit({ key: digest });
  if (!rl.success) return apiError('RATE_LIMITED', 'Too many invalid requests.', 429);
  return apiError('INVALID_INPUT', message, 400, false);
}

async function ownedJob(c: { env: Env; req: { raw: Request; param: (k: string) => string }; set: (k: 'session' | 'newSessionToken', v: string | null) => void }): Promise<JobRow | null> {
  const session = await ensureSession(c, false);
  if (!session) return null;
  const id = c.req.param('id');
  if (!/^inv_[A-Za-z0-9_-]{20,40}$/.test(id)) return null;
  const job = await getJob(c.env.DB, id);
  return job && job.session_digest === session ? job : null;
}

function statusOf(job: JobRow): InvestigationStatus {
  const input = JSON.parse(job.input_json) as JobInput;
  let clarification: Clarification | null = null;
  if (job.state === 'awaiting_clarification' && job.clarification_json) clarification = JSON.parse(job.clarification_json) as Clarification;
  const err = job.state === 'failed' ? errorFor(job.error_code) : null;
  return {
    id: job.id, state: job.state, stage_label: STAGE_LABELS[job.state], market: job.market, product_input: input.product,
    clarification, error: err, report_id: job.state === 'complete' ? job.report_id : null, created_at: job.created_at, updated_at: job.updated_at,
  };
}

function errorFor(code: string | null): InvestigationStatus['error'] {
  switch (code) {
    case 'BUDGET_PAUSED':
      return { code: 'BUDGET_PAUSED', message: 'Research was paused before this investigation could run. Your allowance was not used.', retryable: false };
    case 'TIMEOUT':
      return { code: 'TIMEOUT', message: 'The investigation took too long and was stopped. Your allowance was not used.', retryable: true };
    case 'INVALID_INPUT':
      return { code: 'INVALID_INPUT', message: 'The selected option was not valid.', retryable: true };
    default:
      return { code: 'PROVIDER_UNAVAILABLE', message: 'A technical problem stopped this investigation. Your allowance was not used. Please try again.', retryable: true };
  }
}

app.get('/api/investigations/:id', async (c) => {
  const job = await ownedJob(c);
  if (!job) return apiError('NOT_FOUND', 'Investigation not found.', 404);
  const rl = await c.env.RL_POLL.limit({ key: job.session_digest });
  if (!rl.success) return apiError('RATE_LIMITED', 'Polling too fast.', 429);
  return json(statusOf(job));
});

app.post('/api/investigations/:id/clarify', async (c) => {
  const job = await ownedJob(c);
  if (!job) return apiError('NOT_FOUND', 'Investigation not found.', 404);
  if (job.state !== 'awaiting_clarification' || !job.clarification_json) return apiError('CONFLICT', 'This investigation is not waiting for a choice.', 409, false);
  let candidateId = '';
  try {
    const b = (await c.req.json()) as { candidate_id?: unknown };
    candidateId = typeof b.candidate_id === 'string' ? b.candidate_id : '';
  } catch {
    /* handled below */
  }
  const clar = JSON.parse(job.clarification_json) as Clarification;
  if (!clar.candidates.some((x) => x.id === candidateId)) return apiError('INVALID_INPUT', 'Choose one of the listed options.', 400, false);
  if (Date.parse(clar.expires_at) < Date.now()) return apiError('CONFLICT', 'The choice window has expired.', 409, false);
  const deadline = new Date(Date.now() + JOB_RUNTIME_MS).toISOString();
  await c.env.DB.prepare(`UPDATE investigations SET deadline_at = ?2 WHERE id = ?1`).bind(job.id, deadline).run();
  await setState(c.env.DB, job.id, 'researching', { detail: 'clarified' });
  try {
    const inst = await c.env.INVESTIGATION.get(job.id);
    await inst.sendEvent({ type: 'clarification', payload: { candidate_id: candidateId } });
  } catch {
    await stopJob(c.env, job.id, 'failed', 'PROVIDER_UNAVAILABLE');
  }
  const fresh = await getJob(c.env.DB, job.id);
  return json(statusOf(fresh ?? job), 202);
});

app.post('/api/investigations/:id/cancel', async (c) => {
  const job = await ownedJob(c);
  if (!job) return apiError('NOT_FOUND', 'Investigation not found.', 404);
  if (!TERMINAL_STATES.includes(job.state)) {
    await stopJob(c.env, job.id, 'cancelled', null);
    await terminate(c.env, job.id);
  }
  const fresh = await getJob(c.env.DB, job.id);
  return json(statusOf(fresh ?? job));
});

app.get('/api/reports/:id', async (c) => {
  const session = await ensureSession(c, false);
  const id = c.req.param('id');
  if (!session || !/^rpt_[A-Za-z0-9_-]{20,40}$/.test(id)) return apiError('NOT_FOUND', 'Report not found.', 404);
  const row = await c.env.DB.prepare(
    `SELECT r.snapshot AS snapshot FROM reports r JOIN investigations i ON i.id = r.investigation_id WHERE r.id = ?1 AND i.session_digest = ?2`,
  ).bind(id, session).first<{ snapshot: string }>();
  if (!row) return apiError('NOT_FOUND', 'Report not found.', 404);
  return new Response(row.snapshot, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
});

app.all('/api/*', () => apiError('NOT_FOUND', 'Not found.', 404));

app.onError((err, c) => {
  console.error(JSON.stringify({ event: 'unhandled_error', path: new URL(c.req.url).pathname, name: err.name }));
  return apiError('INTERNAL', 'Something went wrong.', 500);
});

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/') || url.pathname === '/health') {
      const res = await app.fetch(req, env, ctx);
      return withSecurityHeaders(res, { noStore: true, noIndex: true });
    }
    // Reports are rendered client-side from a private API; static pages are public.
    const res = await env.ASSETS.fetch(req);
    return withSecurityHeaders(res);
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(reconcile(env).then((r) => console.log(JSON.stringify({ event: 'reconcile', ...r }))));
  },
} satisfies ExportedHandler<Env>;
