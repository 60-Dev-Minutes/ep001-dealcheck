import { createExecutionContext, introspectWorkflowInstance, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/worker/index';
import type { InvestigationStatus, ReportSnapshot } from '../src/shared/types';

const ORIGIN = 'https://dealcheck.test';
let ipCounter = 10;

function client(ip = `198.51.100.${ipCounter++}`) {
  let cookie = '';
  return {
    ip,
    async call(path: string, init: RequestInit & { json?: unknown } = {}) {
      const headers = new Headers(init.headers);
      headers.set('cf-connecting-ip', ip);
      if (cookie) headers.set('cookie', cookie);
      let body = init.body;
      if (init.json !== undefined) {
        headers.set('content-type', 'application/json');
        if (!headers.has('origin')) headers.set('origin', ORIGIN);
        body = JSON.stringify(init.json);
      }
      const ctx = createExecutionContext();
      const res = await worker.fetch(new Request(ORIGIN + path, { ...init, headers, body }), env, ctx);
      await waitOnExecutionContext(ctx);
      const set = res.headers.get('set-cookie');
      if (set) cookie = set.split(';')[0]!;
      return res;
    },
  };
}

function body(product: string, extra: Record<string, unknown> = {}) {
  return { market: 'NZ', product, price: '799.00', idempotency_key: crypto.randomUUID().replace(/-/g, ''), turnstile_token: 'tok', ...extra };
}

describe('HTTP API', () => {
  beforeEach(() => {
    const real = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('turnstile/v0/siteverify')) {
        const fd = init?.body as FormData;
        return new Response(JSON.stringify({ success: fd.get('response') === 'tok' }));
      }
      return real(input, init);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('health is minimal and markets are listed', async () => {
    const c = client();
    const h = await c.call('/health');
    expect(await h.json()).toEqual({ status: 'ok' });
    expect(h.headers.get('content-security-policy')).toContain("default-src 'self'");
    const m = (await (await c.call('/api/markets')).json()) as { markets: { code: string; currency: string }[] };
    expect(m.markets.map((x) => `${x.code}:${x.currency}`)).toEqual(['US:USD', 'NZ:NZD', 'AU:AUD', 'EE:EUR', 'DE:EUR']);
  });

  it('quota exposes no identity values and sets a hardened session cookie', async () => {
    const c = client();
    const res = await c.call('/api/quota');
    const text = await res.text();
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(text).not.toContain(c.ip);
    expect(text).not.toContain('k1.');
    const q = JSON.parse(text);
    expect(q).toMatchObject({ remaining: 10, total: 10, research_available: true });
    const set = res.headers.get('set-cookie')!;
    expect(set).toMatch(/HttpOnly/);
    expect(set).toMatch(/SameSite=Strict/);
    expect(set).toMatch(/Secure/);
  });

  it('rejects cross-origin and non-JSON state changes', async () => {
    const c = client();
    const bad = await c.call('/api/investigations', { method: 'POST', json: body('x'), headers: { origin: 'https://evil.example' } });
    expect(bad.status).toBe(403);
    const noOrigin = await c.call('/api/investigations', { method: 'POST', body: JSON.stringify(body('x')), headers: { 'content-type': 'application/json' } });
    expect(noOrigin.status).toBe(403);
    const form = await c.call('/api/investigations', { method: 'POST', body: 'a=b', headers: { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' } });
    expect(form.status).toBe(400);
  });

  it('invalid Turnstile fails closed without reserving quota', async () => {
    const c = client();
    const res = await c.call('/api/investigations', { method: 'POST', json: body('FIXTURE-CHEAPER phone', { turnstile_token: 'wrong' }) });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('TURNSTILE_FAILED');
    expect(((await (await c.call('/api/quota')).json()) as { remaining: number }).remaining).toBe(10);
  });

  it('validates input with structured errors', async () => {
    const c = client();
    const cases: [Record<string, unknown>, string][] = [
      [body('x', { market: 'FR' }), 'INVALID_INPUT'],
      [body('x', { price: '€ 799' }), 'MARKET_MISMATCH'],
      [body('x', { price: '1.299' }), 'AMBIGUOUS_PRICE'],
      [body('javascript:alert(1)'), 'INVALID_INPUT'],
      [body('http://169.254.169.254/latest'), 'INVALID_INPUT'],
      [{ ...body('x'), extra: 'field' }, 'INVALID_INPUT'],
    ];
    for (const [b, code] of cases) {
      const res = await c.call('/api/investigations', { method: 'POST', json: b });
      expect(res.status).toBe(400);
      const e = (await res.json()) as { code: string; retryable: boolean };
      expect(e.code).toBe(code);
      expect(e.retryable).toBe(false);
    }
  });

  it('runs a full fixture investigation through the durable workflow', async () => {
    const c = client();
    const res = await c.call('/api/investigations', { method: 'POST', json: body('FIXTURE-CHEAPER <script>alert(1)</script> phone') });
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as { id: string };
    await using inst = await introspectWorkflowInstance(env.INVESTIGATION, id);
    await inst.waitForStatus('complete');
    const st = (await (await c.call(`/api/investigations/${id}`)).json()) as InvestigationStatus;
    expect(st.state).toBe('complete');
    expect(st.product_input).toContain('<script>'); // stored and returned as inert JSON text
    const rep = await c.call(`/api/reports/${st.report_id}`);
    expect(rep.headers.get('cache-control')).toBe('no-store');
    expect(rep.headers.get('x-robots-tag')).toContain('noindex');
    const snap = (await rep.json()) as ReportSnapshot;
    expect(snap.synthetic_fixture).toBe(true);
    expect(snap.verdict).toBe('cheaper_before');
    expect(snap.previous_event?.minimum_minor).toBe(74900);
    expect(snap.offseason?.minimum_minor).toBe(77900);
    expect(snap.overall?.difference_minor).toBe(5000);
    expect(snap.assessed?.basis).toBe('user_entered');
    expect(snap.assessed?.verified_match).toBe('matches');
    expect(snap.advertised_discount?.reference_minor).toBe(99900);
    expect(snap.observations.every((o) => o.currency === 'NZD')).toBe(true);
    // Allowance consumed exactly once; reopening is free.
    expect(((await (await c.call('/api/quota')).json()) as { remaining: number }).remaining).toBe(9);
    await c.call(`/api/reports/${st.report_id}`);
    expect(((await (await c.call('/api/quota')).json()) as { remaining: number }).remaining).toBe(9);
  });

  it('never accepts injected, unretrieved or cross-market observations', async () => {
    const c = client();
    const { id } = (await (await c.call('/api/investigations', { method: 'POST', json: body('FIXTURE-INJECTION phone') })).json()) as { id: string };
    await using inst = await introspectWorkflowInstance(env.INVESTIGATION, id);
    await inst.waitForStatus('complete');
    const st = (await (await c.call(`/api/investigations/${id}`)).json()) as InvestigationStatus;
    const snap = (await (await c.call(`/api/reports/${st.report_id}`)).json()) as ReportSnapshot;
    expect(snap.observations.map((o) => o.amount_minor)).toEqual([78900]);
    expect(snap.verdict).toBe('cheaper_before');
    expect(snap.market.code).toBe('NZ');
    expect(snap.leads.length).toBeGreaterThan(0);
  });

  it('no evidence → valid inconclusive report that still counts', async () => {
    const c = client();
    const { id } = (await (await c.call('/api/investigations', { method: 'POST', json: body('FIXTURE-NONE phone') })).json()) as { id: string };
    await using inst = await introspectWorkflowInstance(env.INVESTIGATION, id);
    await inst.waitForStatus('complete');
    const st = (await (await c.call(`/api/investigations/${id}`)).json()) as InvestigationStatus;
    const snap = (await (await c.call(`/api/reports/${st.report_id}`)).json()) as ReportSnapshot;
    expect(snap.verdict).toBe('insufficient_evidence');
    expect(snap.condition).toBe('no_historical_evidence');
    expect(((await (await c.call('/api/quota')).json()) as { remaining: number }).remaining).toBe(9);
  });

  it('provider failure → technical failure, allowance released', async () => {
    const c = client();
    const { id } = (await (await c.call('/api/investigations', { method: 'POST', json: body('FIXTURE-ERROR phone') })).json()) as { id: string };
    await using inst = await introspectWorkflowInstance(env.INVESTIGATION, id);
    await inst.waitForStatus('complete');
    const st = (await (await c.call(`/api/investigations/${id}`)).json()) as InvestigationStatus;
    expect(st.state).toBe('failed');
    expect(st.error?.retryable).toBe(true);
    expect(((await (await c.call('/api/quota')).json()) as { remaining: number }).remaining).toBe(10);
    const usage = await env.DB.prepare(`SELECT COUNT(*) AS n FROM provider_usage WHERE job_id = ?1`).bind(id).first<{ n: number }>();
    expect(usage!.n).toBe(1); // the failed paid call stays on the ledger
  });

  it('ambiguous variant → clarification → report', async () => {
    const c = client();
    const { id } = (await (await c.call('/api/investigations', { method: 'POST', json: body('FIXTURE-AMBIGUOUS phone', { price: undefined }) })).json()) as { id: string };
    await using inst = await introspectWorkflowInstance(env.INVESTIGATION, id);
    let st: InvestigationStatus;
    for (let i = 0; i < 100; i++) {
      st = (await (await c.call(`/api/investigations/${id}`)).json()) as InvestigationStatus;
      if (st.state === 'awaiting_clarification') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(st!.clarification?.candidates.map((x) => x.id)).toEqual(['c1', 'c2']);
    const bad = await c.call(`/api/investigations/${id}/clarify`, { method: 'POST', json: { candidate_id: 'zzz' } });
    expect(bad.status).toBe(400);
    const ok = await c.call(`/api/investigations/${id}/clarify`, { method: 'POST', json: { candidate_id: 'c1' } });
    expect(ok.status).toBe(202);
    await inst.waitForStatus('complete');
    st = (await (await c.call(`/api/investigations/${id}`)).json()) as InvestigationStatus;
    expect(st.state).toBe('complete');
    const snap = (await (await c.call(`/api/reports/${st.report_id}`)).json()) as ReportSnapshot;
    expect(snap.product.label).toContain('128 GB');
  });

  it('reports and jobs are private to the session receipt', async () => {
    const owner = client();
    const { id } = (await (await owner.call('/api/investigations', { method: 'POST', json: body('FIXTURE-CHEAPER phone') })).json()) as { id: string };
    await using inst = await introspectWorkflowInstance(env.INVESTIGATION, id);
    await inst.waitForStatus('complete');
    const st = (await (await owner.call(`/api/investigations/${id}`)).json()) as InvestigationStatus;
    const stranger = client(owner.ip); // same network, different browser session
    await stranger.call('/api/quota');
    expect((await stranger.call(`/api/investigations/${id}`)).status).toBe(404);
    expect((await stranger.call(`/api/reports/${st.report_id}`)).status).toBe(404);
    expect((await stranger.call(`/api/reports/rpt_' OR 1=1 --aaaaaaaaaaaa`)).status).toBe(404);
    // But the allowance is shared by the network.
    expect(((await (await stranger.call('/api/quota')).json()) as { remaining: number }).remaining).toBe(9);
  });

  it('forged forwarded headers do not create a fresh allowance', async () => {
    const a = client('203.0.113.50');
    await a.call('/api/quota');
    const { id } = (await (await a.call('/api/investigations', { method: 'POST', json: body('FIXTURE-CHEAPER phone') })).json()) as { id: string };
    await using inst = await introspectWorkflowInstance(env.INVESTIGATION, id);
    await inst.waitForStatus('complete');
    const res = await a.call('/api/quota', { headers: { 'x-forwarded-for': '9.9.9.9', 'x-real-ip': '9.9.9.9' } });
    expect(((await res.json()) as { remaining: number }).remaining).toBe(9);
  });

  it('cancellation is idempotent and releases the allowance', async () => {
    const c = client();
    const { id } = (await (await c.call('/api/investigations', { method: 'POST', json: body('FIXTURE-SLOW phone') })).json()) as { id: string };
    const r1 = (await (await c.call(`/api/investigations/${id}/cancel`, { method: 'POST', json: {} })).json()) as InvestigationStatus;
    const r2 = (await (await c.call(`/api/investigations/${id}/cancel`, { method: 'POST', json: {} })).json()) as InvestigationStatus;
    expect(r1.state).toBe('cancelled');
    expect(r2.state).toBe('cancelled');
    expect(((await (await c.call('/api/quota')).json()) as { remaining: number }).remaining).toBe(10);
  });

  it('idempotent resubmission returns the same job', async () => {
    const c = client();
    const b = body('FIXTURE-CHEAPER phone');
    const a1 = (await (await c.call('/api/investigations', { method: 'POST', json: b })).json()) as { id: string };
    const a2 = (await (await c.call('/api/investigations', { method: 'POST', json: { ...b, turnstile_token: 'already-used' } })).json()) as { id: string };
    expect(a2.id).toBe(a1.id);
    await using inst = await introspectWorkflowInstance(env.INVESTIGATION, a1.id);
    await inst.waitForStatus('complete');
  });

  it('kill switch: paused research is reported, existing reports stay readable', async () => {
    const c = client();
    const { id } = (await (await c.call('/api/investigations', { method: 'POST', json: body('FIXTURE-CHEAPER phone') })).json()) as { id: string };
    await using inst = await introspectWorkflowInstance(env.INVESTIGATION, id);
    await inst.waitForStatus('complete');
    await env.DB.prepare(`UPDATE controls SET value = 'true' WHERE key = 'research_paused'`).run();
    try {
      const res = await c.call('/api/investigations', { method: 'POST', json: body('FIXTURE-CHEAPER other') });
      expect(res.status).toBe(503);
      expect(((await res.json()) as { code: string }).code).toBe('BUDGET_PAUSED');
      expect(((await (await c.call('/api/quota')).json()) as { research_available: boolean }).research_available).toBe(false);
      const st = (await (await c.call(`/api/investigations/${id}`)).json()) as InvestigationStatus;
      expect((await c.call(`/api/reports/${st.report_id}`)).status).toBe(200);
    } finally {
      await env.DB.prepare(`UPDATE controls SET value = 'false' WHERE key = 'research_paused'`).run();
    }
  });

  it('no raw IP address is written to any table', async () => {
    const tables = ['sessions', 'quota_buckets', 'reservations', 'investigations', 'investigation_log', 'provider_usage', 'reports'];
    for (const t of tables) {
      const rows = await env.DB.prepare(`SELECT * FROM ${t}`).all();
      expect(JSON.stringify(rows.results)).not.toMatch(/198\.51\.100\.|203\.0\.113\./);
    }
  });
});
