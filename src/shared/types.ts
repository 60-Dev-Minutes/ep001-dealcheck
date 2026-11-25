// Typed contracts shared by the Worker API and the browser client.

export const JOB_STATES = [
  'queued',
  'identifying',
  'awaiting_clarification',
  'researching',
  'validating',
  'complete',
  'failed',
  'cancelled',
] as const;
export type JobState = (typeof JOB_STATES)[number];
export const TERMINAL_STATES: readonly JobState[] = ['complete', 'failed', 'cancelled'];

export type ErrorCode =
  | 'INVALID_INPUT'
  | 'MARKET_MISMATCH'
  | 'AMBIGUOUS_PRICE'
  | 'QUOTA_EXHAUSTED'
  | 'BUDGET_PAUSED'
  | 'BUSY'
  | 'RATE_LIMITED'
  | 'TURNSTILE_FAILED'
  | 'PROVIDER_UNAVAILABLE'
  | 'TIMEOUT'
  | 'FORBIDDEN_ORIGIN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INTERNAL';

export interface ApiError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

export interface MarketInfo {
  code: string;
  name: string;
  currency: string;
}

export interface QuotaInfo {
  /** Approximate investigations remaining for this network during the pilot. */
  remaining: number;
  total: number;
  research_available: boolean;
  /** Reason research is not available, if any. */
  paused_reason: 'budget' | 'disabled' | null;
  turnstile_site_key: string | null;
}

export interface CreateInvestigationRequest {
  market: string;
  product: string;
  price?: string;
  retailer?: string;
  condition?: 'new';
  idempotency_key: string;
  turnstile_token: string;
}

export interface ClarificationCandidate {
  id: string;
  label: string;
  detail: string | null;
}

export interface Clarification {
  kind: 'variant';
  question: string;
  candidates: ClarificationCandidate[];
  expires_at: string;
}

export interface InvestigationStatus {
  id: string;
  state: JobState;
  stage_label: string;
  market: string;
  product_input: string;
  clarification: Clarification | null;
  error: ApiError | null;
  report_id: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------- report snapshot

export type Verdict =
  | 'insufficient_evidence'
  | 'cheaper_before'
  | 'price_matched_before'
  | 'lowest_observed'
  | 'limited_history';

export type ReportCondition =
  | 'ok'
  | 'current_price_unverified'
  | 'no_historical_evidence'
  | 'partial_evidence';

export type Window = 'previous_event' | 'offseason' | 'current_event' | 'earlier_context' | 'straddles_window' | 'same_day_unordered' | 'after_offer';

export type TaxBasis = 'included' | 'excluded' | 'unknown';
export type Eligibility = 'public' | 'member' | 'coupon' | 'trade_in' | 'financing' | 'bundle' | 'restricted' | 'unknown';

export interface ReportObservation {
  id: string;
  amount_minor: number;
  currency: string;
  date_start: string;
  date_end: string;
  date_precision: 'day' | 'interval' | 'month';
  retailer: string | null;
  source_name: string;
  source_url: string;
  source_domain: string;
  source_type: string;
  excerpt: string;
  retrieved_at: string;
  tax_basis: TaxBasis;
  eligibility: Eligibility;
  shipping_minor: number | null;
  window: Window;
  comparable: boolean;
  comparability_notes: string[];
}

export interface ReportLead {
  description: string;
  source_url: string | null;
  reason: string;
}

export interface AssessedOffer {
  amount_minor: number;
  currency: string;
  basis: 'user_entered' | 'verified_offer';
  retailer: string | null;
  source_url: string | null;
  availability: 'in_stock' | 'out_of_stock' | 'preorder' | 'unknown';
  tax_basis: TaxBasis;
  as_of: string;
  as_of_local_date: string;
  verified_match: 'matches' | 'differs' | 'not_checked' | 'not_found';
  verified_amount_minor: number | null;
}

export interface Comparison {
  minimum_minor: number;
  observation_id: string;
  date: string;
  difference_minor: number;
  /** Signed percentage relative to the minimum, one decimal place (C - H) / H. */
  percent: number;
}

export interface Coverage {
  comparable_observations: number;
  distinct_dates: number;
  date_range: { start: string; end: string } | null;
  span_days: number;
  distinct_origins: number;
  months_represented: string[];
  months_missing: string[];
  threshold_met: boolean;
  threshold_rule: string;
}

export interface PromotionExpiry {
  status: 'documented' | 'claimed_unspecified' | 'not_found' | 'conflicting';
  ends_local: string | null;
  source_url: string | null;
  note: string | null;
}

export interface ReportSnapshot {
  schema_version: 1;
  calculation_version: string;
  synthetic_fixture: boolean;
  generated_at: string;
  market: MarketInfo & { timezone: string };
  window_config: {
    edition: string;
    previous_event_date: string;
    offseason_start: string;
    offseason_end: string;
    current_event_start: string;
  };
  product: {
    label: string;
    brand: string | null;
    model: string | null;
    variant: string | null;
    gtin: string | null;
    condition: string;
  };
  assessed: AssessedOffer | null;
  verdict: Verdict;
  verdict_text: string;
  condition: ReportCondition;
  previous_event: Comparison | null;
  offseason: Comparison | null;
  overall: Comparison | null;
  same_retailer: Comparison | null;
  advertised_discount: { reference_minor: number; percent: number; note: string } | null;
  observations: ReportObservation[];
  current_alternatives: ReportObservation[];
  leads: ReportLead[];
  coverage: Coverage;
  promotion_expiry: PromotionExpiry;
  limitations: string[];
  research: {
    model: string;
    searches: number;
    fetches: number;
    duration_ms: number;
    cache_hit: boolean;
  };
}

export const STAGE_LABELS: Record<JobState, string> = {
  queued: 'Queued',
  identifying: 'Identifying the exact product and current offer',
  awaiting_clarification: 'Waiting for you to choose the exact variant',
  researching: 'Searching for dated historical offers',
  validating: 'Validating evidence and calculating',
  complete: 'Report ready',
  failed: 'Technical failure',
  cancelled: 'Cancelled',
};
