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
    const bad = { ...SUBMIT, input: { status: 'resolved', product: null, candidates: 'nope' } };
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
