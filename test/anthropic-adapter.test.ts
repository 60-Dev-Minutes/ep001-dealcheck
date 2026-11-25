import { describe, expect, it } from 'vitest';
import { AnthropicProvider } from '../src/worker/research/anthropic';

const REQ = { marketCode: 'NZ', productInput: 'Acme X-200', userPriceMinor: null, retailerHint: null, chosenCandidate: null, todayLocal: '2026-11-25' };

function message(content: unknown[], stop: string, usage: Record<string, unknown> = {}) {
  return {
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-5-5', stop_reason: stop, stop_sequence: null, content,
    usage: { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: { web_search_requests: 1, web_fetch_requests: 1 }, ...usage },
  };
}

const SUBMIT = {
  type: 'tool_use', id: 'toolu_1', name: 'submit_identification',
  input: { status: 'resolved', product: { label: 'Acme X-200', brand: 'Acme', model: 'X-200', variant: null, gtin: null, price_relevant_attributes: [] }, candidates: [], question: null, current_offer: null },
};

function fakeFetch(responses: { status: number; body: unknown }[], seen: unknown[] = []) {
  let i = 0;
  return (async (_url: RequestInfo | URL, init?: RequestInit) => {
    seen.push(JSON.parse(String(init?.body ?? '{}')));
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json', 'request-id': `req_${i}` } });
  }) as typeof fetch;
}

describe('AnthropicProvider (mocked HTTP)', () => {
  it('sends bounded server tools and parses the submit call plus evidence', async () => {
    const seen: Record<string, unknown>[] = [];
    const p = new AnthropicProvider('test-key', 'claude-haiku-5-5', fakeFetch([{ status: 200, body: message([
      { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_fetch', input: { url: 'https://shop.co.nz/x' } },
      { type: 'web_fetch_tool_result', tool_use_id: 'srvtoolu_1', content: { type: 'web_fetch_result', url: 'https://shop.co.nz/x', retrieved_at: '2026-11-25T00:00:00Z', content: { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'Acme X-200 $10' } } } },
      SUBMIT,
    ], 'tool_use') }], seen));
    const r = await p.identify(REQ, new AbortController().signal);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.output.product?.model).toBe('X-200');
    expect(r.corpus.fetched[0]?.text).toBe('Acme X-200 $10');
    expect(r.meta.usage.web_search_requests).toBe(1);
    expect(r.meta.requestIds).toEqual(['req_1']);
    const tools = seen[0]!.tools as { type?: string; name: string; max_uses?: number; user_location?: { country: string } }[];
    expect(tools.find((t) => t.name === 'web_search')).toMatchObject({ type: 'web_search_20250305', max_uses: 2, user_location: { country: 'NZ' } });
    expect(tools.find((t) => t.name === 'web_fetch')).toMatchObject({ type: 'web_fetch_20250910', max_uses: 1 });
    expect(JSON.stringify(seen[0])).not.toContain('198.51.100'); // no visitor identity in provider requests
  });

  it('continues after pause_turn and accumulates usage', async () => {
    const p = new AnthropicProvider('k', 'claude-haiku-5-5', fakeFetch([
      { status: 200, body: message([{ type: 'text', text: 'searching' }], 'pause_turn') },
      { status: 200, body: message([SUBMIT], 'tool_use') },
    ]));
    const r = await p.identify(REQ, new AbortController().signal);
    expect(r.ok).toBe(true);
    expect(r.ok && r.meta.usage.input_tokens).toBe(2000);
  });

  it('classifies 429 as unbilled and retryable', async () => {
    const p = new AnthropicProvider('k', 'claude-haiku-5-5', fakeFetch([{ status: 429, body: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } } }]));
    const r = await p.identify(REQ, new AbortController().signal);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatchObject({ code: 'rate_limited', billing: 'unbilled', retryable: true });
  });

  it('treats 5xx as unknown billing (conservative)', async () => {
    const p = new AnthropicProvider('k', 'claude-haiku-5-5', fakeFetch([{ status: 500, body: { type: 'error', error: { type: 'api_error', message: 'x' } } }]));
    const r = await p.identify(REQ, new AbortController().signal);
    expect(!r.ok && r.error.billing).toBe('unknown');
  });

  it('rejects schema-invalid model output', async () => {
    const bad = { ...SUBMIT, input: { status: 'not-a-status', product: null, candidates: 'nope' } };
    const p = new AnthropicProvider('k', 'claude-haiku-5-5', fakeFetch([{ status: 200, body: message([bad], 'tool_use') }]));
    const r = await p.identify(REQ, new AbortController().signal);
    expect(!r.ok && r.error.code).toBe('invalid_output');
  });

  it('nudges once, then gives up without unbounded calls', async () => {
    const seen: unknown[] = [];
    const p = new AnthropicProvider('k', 'claude-haiku-5-5', fakeFetch([{ status: 200, body: message([{ type: 'text', text: 'prose answer' }], 'end_turn') }], seen));
    const r = await p.identify(REQ, new AbortController().signal);
    expect(r.ok).toBe(false);
    expect(seen.length).toBeLessThanOrEqual(2);
  });

  it('handles refusals', async () => {
    const p = new AnthropicProvider('k', 'claude-haiku-5-5', fakeFetch([{ status: 200, body: message([], 'refusal') }]));
    const r = await p.identify(REQ, new AbortController().signal);
    expect(!r.ok && r.error.code).toBe('refusal');
  });
});

describe('research output parsing', () => {
  it('drops malformed items instead of failing the whole research, and sends findings non-strict', async () => {
    const { ResearchOutput } = await import('../src/worker/research/provider');
    const good = { amount_minor: 100, currency: 'NZD', date_start: '2026-01-01', date_end: '2026-01-01', date_precision: 'day', retailer: null, source_name: 's', source_url: 'https://a.co.nz/p', source_type: 'other', evidence_excerpt: 'x 1.00', condition: 'new', shipping_minor: null, tax_basis: 'unknown', eligibility: 'public', availability: 'unknown', market: 'NZ', product_match: 'exact', reference_price_minor: null };
    const r = ResearchOutput.parse({ observations: [good, { ...good, amount_minor: -5 }, 'junk'], current_alternatives: null, unverified_leads: [{ description: 'd', source_url: null, reason: 'r', amount_minor: 1, currency: 'NZD', retailer: null, date: null }, { description: 'no new fields' }], promotion_expiry: 'bad', limitations: ['ok', 7] });
    expect(r.observations).toHaveLength(1);
    expect(r.current_alternatives).toEqual([]);
    expect(r.unverified_leads).toHaveLength(1);
    expect(r.promotion_expiry.status).toBe('not_found');
    expect(r.limitations).toEqual(['ok']);
  });
});

describe('search location', () => {
  it('uses the data-driven location (EE: city + timezone, no unsupported country code)', async () => {
    const seen: Record<string, unknown>[] = [];
    const p = new AnthropicProvider('k', 'claude-haiku-5-5', fakeFetch([{ status: 200, body: message([SUBMIT], 'tool_use') }], seen));
    await p.identify({ ...REQ, marketCode: 'EE' }, new AbortController().signal);
    const ws = (seen[0]!.tools as { name: string; user_location?: Record<string, string> }[]).find((t) => t.name === 'web_search')!;
    expect(ws.user_location).toEqual({ type: 'approximate', city: 'Tallinn', timezone: 'Europe/Tallinn' });
  });
  it('retries once without the location hint when the provider rejects the country code', async () => {
    const seen: Record<string, unknown>[] = [];
    const p = new AnthropicProvider('k', 'claude-haiku-5-5', fakeFetch([
      { status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'tools.0.web_search_20250305: Country code NZ is not supported.' } } },
      { status: 200, body: message([SUBMIT], 'tool_use') },
    ], seen));
    const r = await p.identify(REQ, new AbortController().signal);
    expect(r.ok).toBe(true);
    expect(seen).toHaveLength(2);
    const loc = (seen[1]!.tools as { name: string; user_location?: Record<string, string> }[]).find((t) => t.name === 'web_search')!.user_location;
    expect(loc).toEqual({ type: 'approximate', timezone: 'Pacific/Auckland' });
  });
});

describe('identification parsing', () => {
  it('drops invalid optional parts instead of failing the investigation', async () => {
    const { IdentifyOutput } = await import('../src/worker/research/provider');
    const r = IdentifyOutput.parse({
      status: 'resolved',
      product: { label: ' Dyson V15 Detect Absolute ', brand: 'Dyson', model: 'V15', variant: '', gtin: 'B0ABC123', price_relevant_attributes: ['x', 5] },
      candidates: [{ label: 'ok' }, { nope: true }],
      question: 42,
      current_offer: { amount_minor: 'lots' },
    });
    expect(r.product).toMatchObject({ label: 'Dyson V15 Detect Absolute', variant: null, gtin: null, price_relevant_attributes: ['x'] });
    expect(r.candidates).toHaveLength(1);
    expect(r.question).toBeNull();
    expect(r.current_offer).toBeNull();
    expect(IdentifyOutput.parse({ status: 'resolved', product: { label: 'x', brand: null, model: null, variant: null, gtin: '0-12345-67890-5', price_relevant_attributes: [] }, candidates: [], question: null, current_offer: null }).product?.gtin).toBe('012345678905');
    expect(IdentifyOutput.safeParse({ status: 'weird' }).success).toBe(false);
  });
});
