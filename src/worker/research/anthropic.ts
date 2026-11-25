// Anthropic Claude adapter: bounded server-tool research loop (web_search + web_fetch) that must end
// with a structured submit tool call. Model and tool versions are configurable constants.
import Anthropic from '@anthropic-ai/sdk';
import type { ZodType } from 'zod';
import { marketByCode } from '../../shared/markets';
import { IDENTIFY_LIMITS, RESEARCH_LIMITS, type CallLimits, type Usage } from '../pricing';
import { emptyCorpus, type EvidenceCorpus } from './evidence';
import {
  identifySystem,
  identifyUser,
  researchSystem,
  researchUser,
  SUBMIT_FINDINGS_SCHEMA,
  SUBMIT_IDENTIFICATION_SCHEMA,
} from './prompts';
import {
  IdentifyOutput,
  ResearchOutput,
  type IdentifyRequest,
  type ProviderError,
  type ProviderResult,
  type ResearchProvider,
  type ResearchRequest,
} from './provider';

/** Direct-call tool versions: results come back in full so the validator can bind excerpts to page text. */
export const TOOL_VERSIONS = { web_search: 'web_search_20250305', web_fetch: 'web_fetch_20250910' } as const;

interface LoopSpec<T> {
  system: string;
  user: string;
  submitName: string;
  submitDescription: string;
  submitSchema: Record<string, unknown>;
  limits: CallLimits;
  effort: 'low' | 'medium';
  timeoutMs: number;
  marketCode: string;
  schema: ZodType<T>;
}

export class AnthropicProvider implements ResearchProvider {
  readonly name = 'anthropic';
  readonly synthetic = false;
  private client: Anthropic;

  constructor(apiKey: string, private model: string, fetchImpl?: typeof fetch) {
    this.client = new Anthropic({ apiKey, maxRetries: 0, ...(fetchImpl ? { fetch: fetchImpl } : {}) });
  }

  identify(req: IdentifyRequest, signal: AbortSignal): Promise<ProviderResult<IdentifyOutput>> {
    return this.loop(
      {
        system: identifySystem(req),
        user: identifyUser(req),
        submitName: 'submit_identification',
        submitDescription: 'Submit the product identification result. Call exactly once at the end.',
        submitSchema: SUBMIT_IDENTIFICATION_SCHEMA as unknown as Record<string, unknown>,
        limits: IDENTIFY_LIMITS,
        effort: 'low',
        timeoutMs: 45_000,
        marketCode: req.marketCode,
        schema: IdentifyOutput,
      },
      signal,
    );
  }

  research(req: ResearchRequest, signal: AbortSignal): Promise<ProviderResult<ResearchOutput>> {
    return this.loop(
      {
        system: researchSystem(req),
        user: researchUser(req),
        submitName: 'submit_findings',
        submitDescription: 'Submit the historical price findings. Call exactly once at the end.',
        submitSchema: SUBMIT_FINDINGS_SCHEMA as unknown as Record<string, unknown>,
        limits: RESEARCH_LIMITS,
        effort: 'medium',
        timeoutMs: 70_000,
        marketCode: req.marketCode,
        schema: ResearchOutput,
      },
      signal,
    );
  }

  private async loop<T>(spec: LoopSpec<T>, outerSignal: AbortSignal): Promise<ProviderResult<T>> {
    const started = Date.now();
    const market = marketByCode(spec.marketCode)!;
    const corpus = emptyCorpus();
    const usage: Usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, web_search_requests: 0, web_fetch_requests: 0 };
    const requestIds: string[] = [];
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: spec.user }];
    let modelUsed = this.model;
    let stopReason = 'none';
    let nudged = false;
    const meta = () => ({ model: modelUsed, requestIds, usage, durationMs: Date.now() - started, stopReason });
    const deadline = AbortSignal.any([outerSignal, AbortSignal.timeout(spec.timeoutMs)]);

    for (let i = 0; i <= spec.limits.maxContinuations; i++) {
      const remainingSearches = Math.max(1, spec.limits.maxSearches - usage.web_search_requests);
      const remainingFetches = Math.max(1, spec.limits.maxFetches - usage.web_fetch_requests);
      let res: Anthropic.Message;
      try {
        res = await this.client.messages.create(
          {
            model: this.model,
            max_tokens: spec.limits.maxOutputTokens,
            system: spec.system,
            messages,
            output_config: { effort: spec.effort },
            tools: [
              {
                type: TOOL_VERSIONS.web_search,
                name: 'web_search',
                max_uses: remainingSearches,
                user_location: { type: 'approximate', country: market.code, timezone: market.timezone },
              },
              {
                type: TOOL_VERSIONS.web_fetch,
                name: 'web_fetch',
                max_uses: remainingFetches,
                max_content_tokens: spec.limits.maxFetchContentTokens,
              },
              {
                name: spec.submitName,
                description: spec.submitDescription,
                input_schema: spec.submitSchema as Anthropic.Tool.InputSchema,
                strict: true,
              },
            ],
          },
          { signal: deadline, timeout: spec.timeoutMs, maxRetries: 0 },
        );
      } catch (err) {
        return { ok: false, error: classifyError(err, deadline), corpus, meta: requestIds.length ? meta() : null };
      }
      const rid = (res as unknown as { _request_id?: string | null })._request_id;
      if (rid) requestIds.push(rid);
      modelUsed = res.model || modelUsed;
      stopReason = res.stop_reason ?? 'unknown';
      addUsage(usage, res.usage as unknown as Record<string, unknown>);
      collectEvidence(corpus, res.content as unknown[]);

      const submit = (res.content as unknown as { type: string; name?: string; input?: unknown }[]).find(
        (b) => b.type === 'tool_use' && b.name === spec.submitName,
      );
      if (submit) {
        const parsed = spec.schema.safeParse(submit.input);
        if (!parsed.success) {
          return { ok: false, error: { billing: 'billed', code: 'invalid_output', message: 'Model output failed schema validation.', retryable: false }, corpus, meta: meta() };
        }
        return { ok: true, output: parsed.data, corpus, meta: meta() };
      }
      if (res.stop_reason === 'refusal') {
        return { ok: false, error: { billing: 'billed', code: 'refusal', message: 'The model declined the request.', retryable: false }, corpus, meta: meta() };
      }
      messages.push({ role: 'assistant', content: res.content as Anthropic.ContentBlockParam[] });
      if (res.stop_reason === 'pause_turn') continue;
      if (nudged) break;
      nudged = true;
      messages.push({ role: 'user', content: `Stop researching. Call ${spec.submitName} now with only the evidence you already retrieved.` });
    }
    return { ok: false, error: { billing: 'billed', code: 'invalid_output', message: 'The model did not submit a result within the bounded loop.', retryable: false }, corpus, meta: meta() };
  }
}

function addUsage(u: Usage, raw: Record<string, unknown>): void {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  u.input_tokens += n(raw.input_tokens);
  u.output_tokens += n(raw.output_tokens);
  u.cache_creation_input_tokens += n(raw.cache_creation_input_tokens);
  u.cache_read_input_tokens += n(raw.cache_read_input_tokens);
  const stu = (raw.server_tool_use ?? {}) as Record<string, unknown>;
  u.web_search_requests += n(stu.web_search_requests);
  u.web_fetch_requests += n(stu.web_fetch_requests);
}

/** Extracts searched URLs, fetched page text and citations from response content (defensively typed). */
export function collectEvidence(corpus: EvidenceCorpus, content: unknown[]): void {
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue;
    const b = raw as Record<string, unknown>;
    switch (b.type) {
      case 'server_tool_use': {
        const input = (b.input ?? {}) as Record<string, unknown>;
        if (b.name === 'web_search' && typeof input.query === 'string') corpus.queries.push(input.query.slice(0, 300));
        break;
      }
      case 'web_search_tool_result': {
        if (Array.isArray(b.content)) {
          for (const r of b.content as Record<string, unknown>[]) {
            if (r?.type === 'web_search_result' && typeof r.url === 'string') {
              corpus.searchResults.push({ url: r.url, title: String(r.title ?? '').slice(0, 300), page_age: typeof r.page_age === 'string' ? r.page_age : null });
            }
          }
        } else if (b.content && typeof b.content === 'object') {
          corpus.toolErrors.push({ tool: 'web_search', code: String((b.content as Record<string, unknown>).error_code ?? 'unknown') });
        }
        break;
      }
      case 'web_fetch_tool_result': {
        const c = (b.content ?? {}) as Record<string, unknown>;
        if (c.type === 'web_fetch_result' && typeof c.url === 'string') {
          const doc = (c.content ?? {}) as Record<string, unknown>;
          const source = (doc.source ?? {}) as Record<string, unknown>;
          const isText = source.type === 'text' && typeof source.data === 'string';
          corpus.fetched.push({
            url: c.url,
            text: isText ? (source.data as string) : '',
            binary: !isText,
            retrieved_at: typeof c.retrieved_at === 'string' ? c.retrieved_at : new Date().toISOString(),
          });
        } else {
          corpus.toolErrors.push({ tool: 'web_fetch', code: String(c.error_code ?? 'unknown') });
        }
        break;
      }
      case 'text': {
        if (Array.isArray(b.citations)) {
          for (const c of b.citations as Record<string, unknown>[]) {
            if (typeof c?.url === 'string' && typeof c.cited_text === 'string') corpus.citations.push({ url: c.url, cited_text: c.cited_text.slice(0, 600) });
          }
        }
        break;
      }
    }
  }
}

function classifyError(err: unknown, signal: AbortSignal): ProviderError {
  if (err instanceof Anthropic.RateLimitError) return { billing: 'unbilled', code: 'rate_limited', message: 'Provider rate limit.', retryable: true };
  if (err instanceof Anthropic.APIConnectionTimeoutError || signal.aborted) return { billing: 'unknown', code: 'timeout', message: 'Provider call timed out.', retryable: false };
  if (err instanceof Anthropic.APIConnectionError) return { billing: 'unknown', code: 'network', message: 'Provider connection failed.', retryable: true };
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 0;
    if (status === 529) return { billing: 'unbilled', code: 'overloaded', message: 'Provider overloaded.', retryable: true };
    if (status >= 400 && status < 500) {
      const tools = /tool|web_search|web_fetch/i.test(err.message);
      return { billing: 'unbilled', code: tools ? 'tools_unavailable' : 'http_error', message: `Provider rejected the request (${status}).`, retryable: false };
    }
    return { billing: 'unknown', code: 'http_error', message: `Provider error (${status}).`, retryable: status >= 500 };
  }
  return { billing: 'unknown', code: 'network', message: 'Unexpected provider failure.', retryable: false };
}
