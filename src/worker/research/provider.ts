import { z } from 'zod';
import type { Usage } from '../pricing';
import { type EvidenceCorpus, ModelLead, ModelObservation } from './evidence';

// Identification is parsed tolerantly: an invalid optional part (barcode, offer, one candidate,
// over-long text) is dropped or trimmed instead of failing the whole investigation. Only the status
// and, when resolved, a usable product label are required.
const text = (max: number) => z.string().transform((s) => s.trim().slice(0, max));
const optText = (max: number) => z.union([z.string(), z.null(), z.undefined()]).transform((s) => (typeof s === 'string' && s.trim() ? s.trim().slice(0, max) : null)).catch(null);

export const IdentifyOutput = z.object({
  status: z.enum(['resolved', 'ambiguous', 'not_found', 'not_a_product']),
  product: z
    .object({
      label: text(300).refine((s) => s.length > 0),
      brand: optText(120),
      model: optText(160),
      variant: optText(300),
      // GTINs are 8-14 digits; anything else (ASINs, SKUs, spaces) is discarded, not fatal.
      gtin: z.unknown().transform((g) => (typeof g === 'string' && /^\d{8,14}$/.test(g.replace(/[\s-]/g, '')) ? g.replace(/[\s-]/g, '') : null)),
      price_relevant_attributes: z.array(z.unknown()).catch([]).transform((a) => a.filter((x): x is string => typeof x === 'string').slice(0, 10).map((x) => x.slice(0, 120))),
    })
    .nullable()
    .catch(null),
  candidates: z
    .array(z.unknown())
    .catch([])
    .transform((arr) =>
      arr.slice(0, 6).flatMap((x) => {
        const r = z.object({ label: text(300).refine((s) => s.length > 0), brand: optText(120), model: optText(160), variant: optText(300), distinguishing: optText(300) }).safeParse(x);
        return r.success ? [r.data] : [];
      }),
    ),
  question: optText(300),
  current_offer: ModelObservation.nullable().catch(null),
});
export type IdentifyOutput = z.infer<typeof IdentifyOutput>;

/** Keeps only items that pass the schema: one malformed entry never discards the whole research. */
function itemsOf<T extends z.ZodType>(schema: T, max: number) {
  return z
    .array(z.unknown())
    .catch([])
    .transform((arr) => arr.slice(0, max).flatMap((x) => {
      const r = schema.safeParse(x);
      return r.success ? [r.data as z.infer<T>] : [];
    }));
}

export const ResearchOutput = z.object({
  observations: itemsOf(ModelObservation, 40),
  current_alternatives: itemsOf(ModelObservation, 10),
  unverified_leads: itemsOf(ModelLead, 20),
  promotion_expiry: z
    .object({
      status: z.enum(['documented', 'claimed_unspecified', 'not_found', 'conflicting']),
      ends_local: z.string().max(40).nullable(),
      source_url: z.string().max(2048).nullable(),
      evidence_excerpt: z.string().max(600).nullable(),
    })
    .catch({ status: 'not_found', ends_local: null, source_url: null, evidence_excerpt: null }),
  limitations: itemsOf(z.string().max(300), 10),
});
export type ResearchOutput = z.infer<typeof ResearchOutput>;

export interface ProviderMeta {
  model: string;
  requestIds: string[];
  usage: Usage;
  durationMs: number;
  stopReason: string;
}

export type ProviderResult<T> =
  | { ok: true; output: T; corpus: EvidenceCorpus; meta: ProviderMeta }
  | { ok: false; error: ProviderError; corpus: EvidenceCorpus; meta: ProviderMeta | null };

export interface ProviderError {
  /** 'unbilled' only when the failure provably happened before processing (e.g. 429/529 response). */
  billing: 'unbilled' | 'unknown' | 'billed';
  code: 'rate_limited' | 'overloaded' | 'timeout' | 'invalid_output' | 'refusal' | 'http_error' | 'network' | 'tools_unavailable';
  message: string;
  retryable: boolean;
}

export interface IdentifyRequest {
  marketCode: string;
  productInput: string;
  userPriceMinor: number | null;
  retailerHint: string | null;
  chosenCandidate: string | null;
  todayLocal: string;
  access?: AccessHints;
}

/** Learned provider-fetch accessibility per domain for the market (not a permission list). */
export interface AccessHints {
  blocked: string[];
  accessible: string[];
}

export interface ResearchRequest {
  marketCode: string;
  productLabel: string;
  brand: string | null;
  model: string | null;
  variant: string | null;
  gtin: string | null;
  assessedMinor: number | null;
  assessedRetailer: string | null;
  todayLocal: string;
  access?: AccessHints;
}

export interface ResearchProvider {
  readonly name: string;
  readonly synthetic: boolean;
  identify(req: IdentifyRequest, signal: AbortSignal): Promise<ProviderResult<IdentifyOutput>>;
  research(req: ResearchRequest, signal: AbortSignal): Promise<ProviderResult<ResearchOutput>>;
}
