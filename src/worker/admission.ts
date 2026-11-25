// Single transactional admission authority.
//
// Every quota/budget mutation is a D1 batch. A D1 batch executes as one SQLite transaction on the
// database's single writer, so the guarded INSERT … SELECT … WHERE <conditions> statements below
// observe and update a consistent snapshot: no read-then-write race is possible between requests.
// Follow-up statements apply only if the guarded statement in the *same* batch took effect (they
// check for a row carrying this batch's fresh job id / settle token).

import { randomToken } from './identity';

export interface AdmissionRequest {
  jobId: string;
  sessionDigest: string;
  quotaDigest: string;
  quotaKeyVersion: number;
  idempotencyKey: string;
  market: string;
  inputJson: string;
  costReserved: number; // micro-NZD worst case for the whole job
  dayKey: string;
  dailyCap: number; // micro-NZD
  quotaTotal: number;
  globalConcurrency: number;
  now: string;
  deadlineAt: string;
}

export type AdmissionResult =
  | { status: 'admitted'; jobId: string }
  | { status: 'duplicate'; jobId: string }
  | { status: 'quota_exhausted' }
  | { status: 'busy_network' }
  | { status: 'busy_global' }
  | { status: 'budget_paused' }
  | { status: 'paused' };

export async function admit(db: D1Database, r: AdmissionRequest): Promise<AdmissionResult> {
  const admitToken = randomToken(12);
  const guard = `
      NOT EXISTS (SELECT 1 FROM investigations WHERE session_digest = ?1 AND idempotency_key = ?2)
      AND (SELECT completed + reserved FROM quota_buckets WHERE digest = ?3) < ?4
      AND (SELECT COUNT(*) FROM reservations WHERE quota_digest = ?3 AND quota_state = 'active') < 1
      AND (SELECT COUNT(*) FROM reservations WHERE quota_state = 'active') < ?5
      AND (SELECT state = 'open' AND spent_estimate + outstanding_reserved + ?6 <= cap FROM daily_budget WHERE day_key = ?7)
      AND (SELECT value FROM controls WHERE key = 'research_paused') = 'false'`;

  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO quota_buckets (digest, key_version, completed, reserved, updated_at) VALUES (?1, ?2, 0, 0, ?3)`)
      .bind(r.quotaDigest, r.quotaKeyVersion, r.now),
    db.prepare(`INSERT OR IGNORE INTO daily_budget (day_key, spent_estimate, outstanding_reserved, cap, state) VALUES (?1, 0, 0, ?2, 'open')`)
      .bind(r.dayKey, r.dailyCap),
    db.prepare(`UPDATE daily_budget SET cap = ?2 WHERE day_key = ?1 AND cap != ?2`).bind(r.dayKey, r.dailyCap),
    db.prepare(
      `INSERT INTO investigations (id, session_digest, idempotency_key, market, input_json, state, attempt, created_at, updated_at, deadline_at)
       SELECT ?8, ?1, ?2, ?9, ?10, 'queued', 0, ?11, ?11, ?12 WHERE ${guard}`,
    ).bind(r.sessionDigest, r.idempotencyKey, r.quotaDigest, r.quotaTotal, r.globalConcurrency, r.costReserved, r.dayKey,
      r.jobId, r.market, r.inputJson, r.now, r.deadlineAt),
    db.prepare(
      `INSERT OR IGNORE INTO reservations (job_id, quota_digest, day_key, cost_reserved, quota_state, budget_state, admit_token, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, 'active', 'held', ?6, ?5, ?5
       WHERE EXISTS (SELECT 1 FROM investigations WHERE id = ?1 AND session_digest = ?7 AND idempotency_key = ?8)`,
    ).bind(r.jobId, r.quotaDigest, r.dayKey, r.costReserved, r.now, admitToken, r.sessionDigest, r.idempotencyKey),
    // Counter updates apply only if this batch created the reservation (fresh token).
    db.prepare(`UPDATE quota_buckets SET reserved = reserved + 1, updated_at = ?2 WHERE digest = ?1 AND EXISTS (SELECT 1 FROM reservations WHERE job_id = ?3 AND admit_token = ?4)`)
      .bind(r.quotaDigest, r.now, r.jobId, admitToken),
    db.prepare(`UPDATE daily_budget SET outstanding_reserved = outstanding_reserved + ?2 WHERE day_key = ?1 AND EXISTS (SELECT 1 FROM reservations WHERE job_id = ?3 AND admit_token = ?4)`)
      .bind(r.dayKey, r.costReserved, r.jobId, admitToken),
  ]);

  const existing = await db
    .prepare(`SELECT id FROM investigations WHERE session_digest = ?1 AND idempotency_key = ?2`)
    .bind(r.sessionDigest, r.idempotencyKey)
    .first<{ id: string }>();
  if (existing?.id === r.jobId) return { status: 'admitted', jobId: r.jobId };
  if (existing) return { status: 'duplicate', jobId: existing.id };

  // Not admitted: diagnose (informational reads only; the decision above was atomic).
  const diag = await db
    .prepare(
      `SELECT
         (SELECT value FROM controls WHERE key = 'research_paused') AS paused,
         (SELECT completed + reserved FROM quota_buckets WHERE digest = ?1) AS used,
         (SELECT COUNT(*) FROM reservations WHERE quota_digest = ?1 AND quota_state = 'active') AS net_active,
         (SELECT COUNT(*) FROM reservations WHERE quota_state = 'active') AS global_active,
         (SELECT state = 'open' AND spent_estimate + outstanding_reserved + ?2 <= cap FROM daily_budget WHERE day_key = ?3) AS budget_ok`,
    )
    .bind(r.quotaDigest, r.costReserved, r.dayKey)
    .first<{ paused: string; used: number; net_active: number; global_active: number; budget_ok: number }>();
  if (!diag || diag.paused !== 'false') return { status: 'paused' };
  if (diag.used >= r.quotaTotal) return { status: 'quota_exhausted' };
  if (!diag.budget_ok) return { status: 'budget_paused' };
  if (diag.net_active >= 1) return { status: 'busy_network' };
  return { status: 'busy_global' };
}

/**
 * Move the job's quota reservation to `completed` (valid terminal report) or `released`
 * (infrastructure failure, cancellation, abandoned clarification). Idempotent: only the first
 * transition changes counters. Returns true if this call performed the transition.
 */
export async function finalizeQuota(db: D1Database, jobId: string, outcome: 'completed' | 'released', now: string): Promise<boolean> {
  const token = randomToken(12);
  await db.batch([
    db.prepare(`UPDATE reservations SET quota_state = ?2, settle_token = ?3, updated_at = ?4 WHERE job_id = ?1 AND quota_state = 'active'`)
      .bind(jobId, outcome, token, now),
    db.prepare(
      `UPDATE quota_buckets SET reserved = reserved - 1, completed = completed + ?3, updated_at = ?4
       WHERE digest = (SELECT quota_digest FROM reservations WHERE job_id = ?1)
         AND EXISTS (SELECT 1 FROM reservations WHERE job_id = ?1 AND settle_token = ?2)`,
    ).bind(jobId, token, outcome === 'completed' ? 1 : 0, now),
  ]);
  const row = await db.prepare(`SELECT settle_token FROM reservations WHERE job_id = ?1`).bind(jobId).first<{ settle_token: string | null }>();
  return row?.settle_token === token;
}

/**
 * Settle the job's budget hold: release the worst-case reservation and charge the recorded
 * per-call estimates (reconciled actuals, or worst case for calls whose usage is unknown).
 * Must only run once no further provider calls for the job can start. Idempotent.
 */
export async function settleBudget(db: D1Database, jobId: string, now: string): Promise<boolean> {
  const token = randomToken(12);
  await db.batch([
    db.prepare(`UPDATE reservations SET budget_state = 'settled', budget_token = ?2, updated_at = ?3 WHERE job_id = ?1 AND budget_state = 'held'`)
      .bind(jobId, token, now),
    db.prepare(
      `UPDATE daily_budget SET
         outstanding_reserved = MAX(0, outstanding_reserved - (SELECT cost_reserved FROM reservations WHERE job_id = ?1)),
         spent_estimate = spent_estimate + (SELECT COALESCE(SUM(cost_estimate), 0) FROM provider_usage WHERE job_id = ?1)
       WHERE day_key = (SELECT day_key FROM reservations WHERE job_id = ?1)
         AND EXISTS (SELECT 1 FROM reservations WHERE job_id = ?1 AND budget_token = ?2)`,
    ).bind(jobId, token),
  ]);
  const row = await db.prepare(`SELECT budget_token FROM reservations WHERE job_id = ?1`).bind(jobId).first<{ budget_token: string | null }>();
  return row?.budget_token === token;
}

/** Per-call gate checked immediately before every paid provider call. */
export async function mayDispatch(db: D1Database, jobId: string): Promise<{ ok: true } | { ok: false; reason: 'paused' | 'cancelled' | 'no_reservation' }> {
  const row = await db
    .prepare(
      `SELECT i.state AS state, r.budget_state AS budget_state, r.quota_state AS quota_state,
              (SELECT value FROM controls WHERE key = 'research_paused') AS paused,
              (SELECT state FROM daily_budget WHERE day_key = r.day_key) AS day_state
       FROM investigations i LEFT JOIN reservations r ON r.job_id = i.id WHERE i.id = ?1`,
    )
    .bind(jobId)
    .first<{ state: string; budget_state: string | null; quota_state: string | null; paused: string; day_state: string | null }>();
  if (!row || row.budget_state !== 'held' || row.quota_state !== 'active') return { ok: false, reason: 'no_reservation' };
  if (row.state === 'cancelled' || row.state === 'failed') return { ok: false, reason: 'cancelled' };
  if (row.paused !== 'false' || row.day_state !== 'open') return { ok: false, reason: 'paused' };
  return { ok: true };
}

export async function recordCallStart(
  db: D1Database,
  c: { callId: string; jobId: string; stage: string; provider: string; model: string; estimate: number; rateVersion: string; now: string },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO provider_usage (call_id, job_id, stage, provider, model, cost_estimate, rate_version, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'dispatched', ?8, ?8)`,
    )
    .bind(c.callId, c.jobId, c.stage, c.provider, c.model, c.estimate, c.rateVersion, c.now)
    .run();
}

export interface CallResult {
  status: 'reconciled' | 'failed_unbilled' | 'unknown';
  model?: string;
  requestId?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  searches?: number;
  fetches?: number;
  /** Required for 'reconciled'. Ignored for 'unknown' (worst case is retained). */
  cost?: number;
  durationMs: number;
}

/**
 * Record the outcome of a dispatched call. 'unknown' keeps the conservative worst-case estimate.
 * 'failed_unbilled' is only for responses that prove no processing happened (e.g. 429/529).
 * If the job's budget was already settled, any increase is charged directly.
 */
export async function recordCallResult(db: D1Database, callId: string, r: CallResult, now: string): Promise<void> {
  const prev = await db.prepare(`SELECT cost_estimate, job_id FROM provider_usage WHERE call_id = ?1`).bind(callId).first<{ cost_estimate: number; job_id: string }>();
  if (!prev) return;
  const newCost = r.status === 'reconciled' ? Math.max(0, r.cost ?? prev.cost_estimate) : r.status === 'failed_unbilled' ? 0 : prev.cost_estimate;
  const delta = newCost - prev.cost_estimate;
  await db.batch([
    db.prepare(
      `UPDATE provider_usage SET status = ?2, model = COALESCE(?3, model), request_id = ?4, input_tokens = ?5, output_tokens = ?6,
         cache_read_tokens = ?7, cache_write_tokens = ?8, web_search_requests = ?9, web_fetch_requests = ?10,
         cost_estimate = ?11, duration_ms = ?12, updated_at = ?13 WHERE call_id = ?1`,
    ).bind(callId, r.status, r.model ?? null, r.requestId ?? null, r.inputTokens ?? null, r.outputTokens ?? null,
      r.cacheReadTokens ?? null, r.cacheWriteTokens ?? null, r.searches ?? null, r.fetches ?? null, newCost, r.durationMs, now),
    // Late result after settlement: only ever increase the charged amount.
    db.prepare(
      `UPDATE daily_budget SET spent_estimate = spent_estimate + ?2
       WHERE ?2 > 0 AND day_key = (SELECT day_key FROM reservations WHERE job_id = ?1 AND budget_state = 'settled')`,
    ).bind(prev.job_id, delta),
  ]);
}

export interface QuotaView {
  used: number;
  remaining: number;
}

export async function quotaView(db: D1Database, digest: string, total: number): Promise<QuotaView> {
  const row = await db.prepare(`SELECT completed + reserved AS used FROM quota_buckets WHERE digest = ?1`).bind(digest).first<{ used: number }>();
  const used = row?.used ?? 0;
  return { used, remaining: Math.max(0, total - used) };
}

export async function budgetOpen(db: D1Database, dayKey: string, cap: number, minCost: number): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT (SELECT value FROM controls WHERE key = 'research_paused') AS paused,
              (SELECT state = 'open' AND spent_estimate + outstanding_reserved + ?2 <= cap FROM daily_budget WHERE day_key = ?1) AS ok`,
    )
    .bind(dayKey, minCost)
    .first<{ paused: string; ok: number | null }>();
  if (!row || row.paused !== 'false') return false;
  return row.ok === null ? minCost <= cap : row.ok === 1;
}

/** Pacific/Auckland (or configured) calendar date for budget attribution. */
export function dayKeyFor(date: Date, timeZone: string): string {
  return localDate(date, timeZone);
}

export function localDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
