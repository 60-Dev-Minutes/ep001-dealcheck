import { settleBudget } from './admission';
import type { Env } from './env';
import { logEvent, nowIso, stopJob } from './pipeline';

/**
 * Periodic reconciliation (cron): time out stuck jobs, abandon expired clarifications and settle
 * budget holds of terminal jobs. Never refunds spend that was recorded for dispatched calls.
 */
export async function reconcile(env: Env, now = new Date()): Promise<{ timedOut: number; abandoned: number; settled: number }> {
  const graceIso = new Date(now.getTime() - 60_000).toISOString();
  const stuck = await env.DB.prepare(
    `SELECT id FROM investigations WHERE state IN ('queued','identifying','researching','validating') AND deadline_at < ?1 LIMIT 50`,
  ).bind(graceIso).all<{ id: string }>();
  for (const { id } of stuck.results) {
    await logEvent(env.DB, id, 'timeout', 'job exceeded runtime bound');
    await stopJob(env, id, 'failed', 'TIMEOUT');
    await terminate(env, id);
  }
  const waiting = await env.DB.prepare(
    `SELECT id, clarification_json FROM investigations WHERE state = 'awaiting_clarification' LIMIT 50`,
  ).all<{ id: string; clarification_json: string | null }>();
  let abandoned = 0;
  for (const w of waiting.results) {
    const exp = w.clarification_json ? (JSON.parse(w.clarification_json) as { expires_at?: string }).expires_at : undefined;
    if (!exp || Date.parse(exp) + 60_000 < now.getTime()) {
      await stopJob(env, w.id, 'cancelled', null);
      await terminate(env, w.id);
      abandoned++;
    }
  }
  const held = await env.DB.prepare(
    `SELECT r.job_id AS id FROM reservations r JOIN investigations i ON i.id = r.job_id
     WHERE r.budget_state = 'held' AND i.state IN ('complete','failed','cancelled') AND i.updated_at < ?1 LIMIT 100`,
  ).bind(new Date(now.getTime() - 5 * 60_000).toISOString()).all<{ id: string }>();
  let settled = 0;
  for (const { id } of held.results) if (await settleBudget(env.DB, id, nowIso())) settled++;
  return { timedOut: stuck.results.length, abandoned, settled };
}

export async function terminate(env: Env, id: string): Promise<void> {
  try {
    const inst = await env.INVESTIGATION.get(id);
    await inst.terminate();
  } catch {
    /* already finished or unknown */
  }
}
