import { beforeEach, describe, expect, it } from 'vitest';
import { finalizeQuota, mayDispatch, recordCallResult, recordCallStart, settleBudget, dayKeyFor } from '../src/worker/admission';
import { admit, budget, bucket, CAP, DAY, env, req } from './helpers';

async function completeJob(jobId: string) {
  await env.DB.prepare(`UPDATE investigations SET state = 'complete' WHERE id = ?1`).bind(jobId).run();
  await finalizeQuota(env.DB, jobId, 'completed', 'now');
  await settleBudget(env.DB, jobId, 'now');
}

describe('admission ledger', () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM provider_usage'), env.DB.prepare('DELETE FROM reservations'), env.DB.prepare('DELETE FROM reports'),
      env.DB.prepare('DELETE FROM investigations'), env.DB.prepare('DELETE FROM quota_buckets'), env.DB.prepare('DELETE FROM daily_budget'),
      env.DB.prepare(`UPDATE controls SET value = 'false' WHERE key = 'research_paused'`),
    ]);
  });

  it('admits and reserves atomically', async () => {
    const r = await admit(env.DB, req());
    expect(r.status).toBe('admitted');
    expect(await bucket('k1.net-a')).toEqual({ completed: 0, reserved: 1 });
    expect((await budget())!.outstanding_reserved).toBe(1_000_000);
  });

  it('allows only one in-flight job per network', async () => {
    expect((await admit(env.DB, req())).status).toBe('admitted');
    expect((await admit(env.DB, req({ sessionDigest: 'sess-other' }))).status).toBe('busy_network');
  });

  it('blocks the 11th investigation for a network, sequentially', async () => {
    for (let i = 0; i < 10; i++) {
      const r = await admit(env.DB, req());
      expect(r.status).toBe('admitted');
      await completeJob((r as { jobId: string }).jobId);
    }
    expect(await bucket('k1.net-a')).toEqual({ completed: 10, reserved: 0 });
    expect((await admit(env.DB, req())).status).toBe('quota_exhausted');
  });

  it('parallel requests at the 10th slot admit at most one', async () => {
    for (let i = 0; i < 9; i++) {
      const r = await admit(env.DB, req());
      await completeJob((r as { jobId: string }).jobId);
    }
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => admit(env.DB, req({ sessionDigest: `s${i}` }))));
    expect(results.filter((r) => r.status === 'admitted')).toHaveLength(1);
    const b = (await bucket('k1.net-a'))!;
    expect(b.completed + b.reserved).toBe(10);
  });

  it('repeated idempotency key never double charges', async () => {
    const shared = req({ idempotencyKey: 'same-key-123' });
    const results = await Promise.all([admit(env.DB, shared), admit(env.DB, { ...shared, jobId: 'inv_other_aaaaaaaaaaaaaaaaaaaaaa' }), admit(env.DB, shared)]);
    const ids = new Set(results.map((r) => ('jobId' in r ? r.jobId : r.status)));
    expect(ids.size).toBe(1);
    expect(await bucket('k1.net-a')).toEqual({ completed: 0, reserved: 1 });
  });

  it('enforces global concurrency across networks', async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => admit(env.DB, req({ quotaDigest: `k1.n${i}`, sessionDigest: `s${i}` }))));
    expect(results.filter((r) => r.status === 'admitted')).toHaveLength(5);
    expect(results.filter((r) => r.status === 'busy_global')).toHaveLength(3);
  });

  it('simultaneous budget reservations never exceed the cap', async () => {
    const cost = 9_000_000; // NZ$9 worst case → only two fit in NZ$25
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) => admit(env.DB, req({ quotaDigest: `k1.b${i}`, sessionDigest: `b${i}`, costReserved: cost }))));
    expect(results.filter((r) => r.status === 'admitted')).toHaveLength(2);
    expect(results.filter((r) => r.status === 'budget_paused')).toHaveLength(3);
    const b = (await budget())!;
    expect(b.spent_estimate + b.outstanding_reserved).toBeLessThanOrEqual(CAP);
  });

  it('settlement charges recorded usage, releases the hold, and is idempotent under races', async () => {
    const r = (await admit(env.DB, req())) as { jobId: string };
    await recordCallStart(env.DB, { callId: 'c1', jobId: r.jobId, stage: 'identify', provider: 'fixture', model: 'm', estimate: 400_000, rateVersion: 'v', now: 'now' });
    await recordCallResult(env.DB, 'c1', { status: 'reconciled', cost: 120_000, durationMs: 5 }, 'now');
    await recordCallStart(env.DB, { callId: 'c2', jobId: r.jobId, stage: 'research', provider: 'fixture', model: 'm', estimate: 500_000, rateVersion: 'v', now: 'now' });
    await recordCallResult(env.DB, 'c2', { status: 'unknown', durationMs: 5 }, 'now'); // timeout after dispatch: keep worst case
    await env.DB.prepare(`UPDATE investigations SET state = 'complete' WHERE id = ?1`).bind(r.jobId).run();
    const q = await Promise.all([finalizeQuota(env.DB, r.jobId, 'completed', 'now'), finalizeQuota(env.DB, r.jobId, 'released', 'now'), finalizeQuota(env.DB, r.jobId, 'completed', 'now')]);
    expect(q.filter(Boolean)).toHaveLength(1);
    const s = await Promise.all([settleBudget(env.DB, r.jobId, 'now'), settleBudget(env.DB, r.jobId, 'now')]);
    expect(s.filter(Boolean)).toHaveLength(1);
    const b = (await budget())!;
    expect(b.outstanding_reserved).toBe(0);
    expect(b.spent_estimate).toBe(620_000);
    const bk = (await bucket('k1.net-a'))!;
    expect(bk.reserved).toBe(0);
    expect(bk.completed + bk.reserved).toBeLessThanOrEqual(1);
  });

  it('failed paid call with unbilled proof is not charged; late increase after settlement is charged', async () => {
    const r = (await admit(env.DB, req())) as { jobId: string };
    await recordCallStart(env.DB, { callId: 'u1', jobId: r.jobId, stage: 'identify', provider: 'p', model: 'm', estimate: 300_000, rateVersion: 'v', now: 'now' });
    await recordCallResult(env.DB, 'u1', { status: 'failed_unbilled', durationMs: 1 }, 'now');
    await recordCallStart(env.DB, { callId: 'u2', jobId: r.jobId, stage: 'identify', provider: 'p', model: 'm', estimate: 300_000, rateVersion: 'v', now: 'now' });
    await finalizeQuota(env.DB, r.jobId, 'released', 'now');
    await settleBudget(env.DB, r.jobId, 'now');
    expect((await budget())!.spent_estimate).toBe(300_000);
    await recordCallResult(env.DB, 'u2', { status: 'reconciled', cost: 450_000, durationMs: 1 }, 'now');
    expect((await budget())!.spent_estimate).toBe(450_000);
    await recordCallResult(env.DB, 'u2', { status: 'reconciled', cost: 100_000, durationMs: 1 }, 'now');
    expect((await budget())!.spent_estimate).toBe(450_000); // never refunds after settlement
  });

  it('cancellation releases the quota slot but keeps spend', async () => {
    const r = (await admit(env.DB, req())) as { jobId: string };
    await recordCallStart(env.DB, { callId: 'x1', jobId: r.jobId, stage: 'identify', provider: 'p', model: 'm', estimate: 200_000, rateVersion: 'v', now: 'now' });
    await env.DB.prepare(`UPDATE investigations SET state = 'cancelled' WHERE id = ?1`).bind(r.jobId).run();
    expect((await mayDispatch(env.DB, r.jobId)).ok).toBe(false);
    await finalizeQuota(env.DB, r.jobId, 'released', 'now');
    await settleBudget(env.DB, r.jobId, 'now');
    expect(await bucket('k1.net-a')).toEqual({ completed: 0, reserved: 0 });
    expect((await budget())!.spent_estimate).toBe(200_000);
  });

  it('kill switch stops admission and dispatch independent of quota', async () => {
    const r = (await admit(env.DB, req())) as { jobId: string };
    expect((await mayDispatch(env.DB, r.jobId)).ok).toBe(true);
    await env.DB.prepare(`UPDATE controls SET value = 'true' WHERE key = 'research_paused'`).run();
    expect(await mayDispatch(env.DB, r.jobId)).toEqual({ ok: false, reason: 'paused' });
    expect((await admit(env.DB, req({ quotaDigest: 'k1.z', sessionDigest: 'z' }))).status).toBe('paused');
  });

  it('day rollover: new NZ day gets a fresh cap, pending holds stay on their original day', async () => {
    const r1 = (await admit(env.DB, req({ costReserved: 20_000_000 }))) as { jobId: string };
    expect((await admit(env.DB, req({ quotaDigest: 'k1.d2', sessionDigest: 'd2', costReserved: 20_000_000 }))).status).toBe('budget_paused');
    const tomorrow = '2026-11-26';
    expect((await admit(env.DB, req({ quotaDigest: 'k1.d3', sessionDigest: 'd3', costReserved: 20_000_000, dayKey: tomorrow }))).status).toBe('admitted');
    await finalizeQuota(env.DB, r1.jobId, 'released', 'now');
    await settleBudget(env.DB, r1.jobId, 'now');
    expect((await budget(DAY))!.outstanding_reserved).toBe(0);
    expect((await budget(tomorrow))!.outstanding_reserved).toBe(20_000_000);
  });

  it('computes the Pacific/Auckland day key across UTC midnight', () => {
    expect(dayKeyFor(new Date('2026-11-25T10:59:59Z'), 'Pacific/Auckland')).toBe('2026-11-25');
    expect(dayKeyFor(new Date('2026-11-25T11:00:00Z'), 'Pacific/Auckland')).toBe('2026-11-26'); // NZDT = UTC+13
    expect(DAY).toBe('2026-11-25');
  });
});
