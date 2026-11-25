import { describe, expect, it } from 'vitest';
import { recordCallStart } from '../src/worker/admission';
import { reconcile } from '../src/worker/reconcile';
import { admit, budget, bucket, env, req } from './helpers';

describe('reconciler', () => {
  it('times out stuck jobs, abandons expired clarifications, keeps conservative spend', async () => {
    const stuck = (await admit(env.DB, req({ quotaDigest: 'k1.r1', sessionDigest: 'r1', deadlineAt: '2026-11-25T01:00:00.000Z' }))) as { jobId: string };
    await env.DB.prepare(`UPDATE investigations SET state = 'researching' WHERE id = ?1`).bind(stuck.jobId).run();
    await recordCallStart(env.DB, { callId: 'r-call', jobId: stuck.jobId, stage: 'research', provider: 'p', model: 'm', estimate: 700_000, rateVersion: 'v', now: 'now' });

    const waiting = (await admit(env.DB, req({ quotaDigest: 'k1.r2', sessionDigest: 'r2' }))) as { jobId: string };
    await env.DB.prepare(`UPDATE investigations SET state = 'awaiting_clarification', clarification_json = ?2 WHERE id = ?1`)
      .bind(waiting.jobId, JSON.stringify({ kind: 'variant', question: 'q', candidates: [], expires_at: '2026-11-25T01:00:00.000Z' })).run();

    const r = await reconcile(env, new Date('2026-11-25T02:00:00Z'));
    expect(r.timedOut).toBe(1);
    expect(r.abandoned).toBe(1);
    const s1 = await env.DB.prepare(`SELECT state, error_code FROM investigations WHERE id = ?1`).bind(stuck.jobId).first();
    expect(s1).toEqual({ state: 'failed', error_code: 'TIMEOUT' });
    const s2 = await env.DB.prepare(`SELECT state FROM investigations WHERE id = ?1`).bind(waiting.jobId).first();
    expect(s2).toEqual({ state: 'cancelled' });
    expect(await bucket('k1.r1')).toEqual({ completed: 0, reserved: 0 });
    expect(await bucket('k1.r2')).toEqual({ completed: 0, reserved: 0 });
    const b = (await budget())!;
    expect(b.outstanding_reserved).toBe(0);
    expect(b.spent_estimate).toBe(700_000); // dispatched call with unknown outcome stays charged at worst case
    // Second pass is a no-op.
    expect(await reconcile(env, new Date('2026-11-25T02:05:00Z'))).toEqual({ timedOut: 0, abandoned: 0, settled: 0 });
  });
});
