// Dated, conservative pricing configuration. All arithmetic is integer:
//   token rates in nano-USD per token (== USD per million tokens × 1000),
//   FX as NZD per USD × 1000, results in micro-NZD, always rounded up.
//
// Sources (retrieved 2026-11-25 UTC): platform.claude.com/docs/en/about-claude/pricing,
// .../tool-use/web-search-tool ("$10 per 1,000 searches"), .../tool-use/web-fetch-tool ("no additional cost").
// FX: ECB reference via frankfurter.dev 2026-11-24 = 1.8278 NZD/USD (6-month max 1.8355);
// configured at 1.95 (~6.7% above spot) as a conservative buffer.

export const PRICING_VERSION = 'anthropic-2026-11-25.fx-1.95';
export const FX_NZD_PER_USD_MILLI = 1950;
export const WEB_SEARCH_NANO_USD = 10_000_000; // $0.01 per search
export const WEB_FETCH_NANO_USD = 0;

interface ModelRates {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  /** Optional long-prompt tier (Haiku 5.5: prompts over 100k tokens). */
  long?: { thresholdTokens: number; input: number; output: number; cacheWrite: number; cacheRead: number };
}

const RATES: Record<string, ModelRates> = {
  'claude-haiku-5-5': {
    input: 100, output: 500, cacheWrite: 125, cacheRead: 10,
    long: { thresholdTokens: 100_000, input: 500, output: 2500, cacheWrite: 625, cacheRead: 50 },
  },
  'claude-sonnet-5-5': { input: 2000, output: 10000, cacheWrite: 2500, cacheRead: 100 },
  'claude-opus-5-5': { input: 4000, output: 20000, cacheWrite: 5000, cacheRead: 200 },
};

/** Pricing must be known; unknown models fail closed (no paid work). */
export function ratesFor(model: string): ModelRates | null {
  return RATES[model] ?? null;
}

export interface CallLimits {
  maxSearches: number;
  maxFetches: number;
  maxFetchContentTokens: number;
  maxOutputTokens: number;
  /** Conservative estimate of system + user prompt + tool definitions. */
  basePromptTokens: number;
  /** Conservative upper estimate of tokens added to context by one search result set. */
  searchResultTokens: number;
  /** Continuations after pause_turn; each re-reads the full context. */
  maxContinuations: number;
}

export const IDENTIFY_LIMITS: CallLimits = {
  maxSearches: 2,
  maxFetches: 1,
  maxFetchContentTokens: 8000,
  maxOutputTokens: 6000,
  basePromptTokens: 5000,
  searchResultTokens: 12000,
  maxContinuations: 1,
};

export const RESEARCH_LIMITS: CallLimits = {
  maxSearches: 6,
  maxFetches: 3,
  maxFetchContentTokens: 8000,
  maxOutputTokens: 10000,
  basePromptTokens: 7000,
  searchResultTokens: 12000,
  maxContinuations: 1,
};

/**
 * Worst-case input tokens for a server-tool loop: the model is sampled once per tool use plus once
 * more, and each sampling re-reads everything accumulated so far.
 */
export function worstCaseInputTokens(l: CallLimits): number {
  // A continuation may re-enable one more search and fetch (max_uses is per turn and must be >= 1).
  const n = l.maxSearches + l.maxFetches + 2 * l.maxContinuations;
  const perTool = Math.max(l.searchResultTokens, l.maxFetchContentTokens);
  const samplings = n + 1 + l.maxContinuations;
  return samplings * l.basePromptTokens + perTool * ((n * (n + 1)) / 2 + l.maxContinuations * n);
}

function nanoToMicroNzd(nanoUsd: number): number {
  // micro-NZD = nano-USD / 1000 × FX ; ceil for conservatism
  return Math.ceil((nanoUsd * FX_NZD_PER_USD_MILLI) / 1_000_000);
}

/** Worst-case cost of one bounded provider call, in micro-NZD. Null if pricing unknown. */
export function worstCaseCallCost(model: string, l: CallLimits): number | null {
  const r = ratesFor(model);
  if (!r) return null;
  const input = worstCaseInputTokens(l);
  // Price every token at the highest applicable tier.
  const inRate = Math.max(r.input, r.cacheWrite, r.long?.input ?? 0, r.long?.cacheWrite ?? 0);
  const outRate = Math.max(r.output, r.long?.output ?? 0);
  const nano = input * inRate + l.maxOutputTokens * outRate + (l.maxSearches + l.maxContinuations) * WEB_SEARCH_NANO_USD + (l.maxFetches + l.maxContinuations) * WEB_FETCH_NANO_USD;
  return nanoToMicroNzd(nano);
}

/** Worst-case cost of a whole investigation (identification + research pass). */
export function worstCaseJobCost(model: string): number | null {
  const a = worstCaseCallCost(model, IDENTIFY_LIMITS);
  const b = worstCaseCallCost(model, RESEARCH_LIMITS);
  return a === null || b === null ? null : a + b;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  web_search_requests: number;
  web_fetch_requests: number;
}

/** Estimated actual cost from reported usage, in micro-NZD (conservative tiering). */
export function usageCost(model: string, u: Usage): number | null {
  const r = ratesFor(model);
  if (!r) return null;
  const promptTokens = u.input_tokens + u.cache_creation_input_tokens + u.cache_read_input_tokens;
  // Usage is cumulative across server-loop samplings, so per-sampling prompt size is unknown:
  // if the cumulative prompt exceeds the long-tier threshold, price everything at the long tier.
  const tier = r.long && promptTokens > r.long.thresholdTokens ? r.long : r;
  const nano =
    u.input_tokens * tier.input +
    u.cache_creation_input_tokens * tier.cacheWrite +
    u.cache_read_input_tokens * tier.cacheRead +
    u.output_tokens * tier.output +
    u.web_search_requests * WEB_SEARCH_NANO_USD +
    u.web_fetch_requests * WEB_FETCH_NANO_USD;
  return nanoToMicroNzd(nano);
}

export function formatMicroNzd(micro: number): string {
  return `NZ$${(micro / 1_000_000).toFixed(4)}`;
}
