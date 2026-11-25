import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import worker from '../src/worker/index';
import type { RecentCheck } from '../src/shared/types';

async function recent(): Promise<{ res: Response; body: { recent: RecentCheck[] } }> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request('https://dealcheck.test/api/recent'), env, ctx);
  await waitOnExecutionContext(ctx);
  return { res, body: await res.clone().json() };
}

async function seed(id: string, snapshot: Record<string, unknown>, input: string, state = 'complete', at = '2026-11-25T03:00:00.000Z') {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO investigations (id, session_digest, idempotency_key, market, input_json, state, created_at, updated_at, deadline_at) VALUES (?1, 's', ?1, 'NZ', ?2, ?3, ?4, ?4, ?4)`)
      .bind(id, JSON.stringify({ market: 'NZ', product: input, price_minor: 12345, retailer: null }), state, at),
    env.DB.prepare(`INSERT INTO reports (id, investigation_id, snapshot, calculation_version, evidence_ids, generated_at) VALUES (?1, ?2, ?3, 'calc', '[]', ?4)`)
      .bind(`rpt_${id}`, id, JSON.stringify(snapshot), at),
  ]);
}

describe('GET /api/recent', () => {
  it('publishes only identified product names, never raw input, prices, ids or test data', async () => {
    await seed('inv_recent_identified_aaaaaa', { synthetic_fixture: false, verdict: 'cheaper_before', product: { label: 'Sony WH-1000XM5 Headphones (Black)', model: 'WH-1000XM5' } }, 'my secret typed text sony', 'complete', '2026-11-25T03:00:00.000Z');
    await seed('inv_recent_unidentified_aaaa', { synthetic_fixture: false, verdict: 'insufficient_evidence', product: { label: 'raw text the user typed', model: null } }, 'raw text the user typed', 'complete', '2026-11-25T03:01:00.000Z');
    await seed('inv_recent_synthetic_aaaaaaa', { synthetic_fixture: true, verdict: 'cheaper_before', product: { label: 'Fixture Phone', model: 'FX-100' } }, 'FIXTURE-CHEAPER', 'complete', '2026-11-25T03:02:00.000Z');
    await seed('inv_recent_failed_aaaaaaaaaa', { synthetic_fixture: false, verdict: 'cheaper_before', product: { label: 'Failed One', model: 'F1' } }, 'x', 'failed', '2026-11-25T03:03:00.000Z');
    const { res, body } = await recent();
    expect(res.headers.get('cache-control')).toContain('max-age=30');
    expect(body.recent).toEqual([{ product: 'Sony WH-1000XM5 Headphones (Black)', market: 'NZ', verdict: 'cheaper_before', finished_at: '2026-11-25T03:00:00.000Z' }]);
    const text = JSON.stringify(body);
    for (const leak of ['secret typed', 'raw text', 'Fixture', 'Failed One', '12345', 'rpt_', 'inv_']) expect(text).not.toContain(leak);
  });
});

describe('cache policy', () => {
  it('personalised endpoints stay no-store; public ones are briefly cacheable', async () => {
    const ctx = createExecutionContext();
    const q = await worker.fetch(new Request('https://dealcheck.test/api/quota', { headers: { 'cf-connecting-ip': '198.51.100.200' } }), env, ctx);
    const m = await worker.fetch(new Request('https://dealcheck.test/api/markets'), env, ctx);
    const r = await worker.fetch(new Request('https://dealcheck.test/api/reports/rpt_aaaaaaaaaaaaaaaaaaaaaaaa'), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(q.headers.get('cache-control')).toBe('no-store');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(m.headers.get('cache-control')).toBe('public, max-age=300');
  });
});
