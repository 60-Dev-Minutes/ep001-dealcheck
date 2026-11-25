import { z } from 'zod';
import type { Usage } from '../pricing';
import { type EvidenceCorpus, ModelLead, ModelObservation } from './evidence';

export const IdentifyOutput = z.object({
  status: z.enum(['resolved', 'ambiguous', 'not_found', 'not_a_product']),
  product: z
    .object({
      label: z.string().min(1).max(300),
      brand: z.string().max(120).nullable(),
      model: z.string().max(160).nullable(),
      variant: z.string().max(300).nullable(),
      gtin: z.string().regex(/^\d{8,14}$/).nullable(),
      price_relevant_attributes: z.array(z.string().max(120)).max(10),
    })
    .nullable(),
  candidates: z
    .array(
      z.object({
        label: z.string().min(1).max(300),
        brand: z.string().max(120).nullable(),
        model: z.string().max(160).nullable(),
        variant: z.string().max(300).nullable(),
        distinguishing: z.string().max(300).nullable(),
      }),
    )
    .max(6),
  question: z.string().max(300).nullable(),
  current_offer: ModelObservation.nullable(),
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
