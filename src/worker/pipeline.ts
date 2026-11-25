// Investigation stages executed by the durable Workflow. Each stage is idempotent with respect to
// state transitions and checks the per-call admission gate before any paid provider call.
import { EVENT_CONFIG, marketByCode, type Market } from '../shared/markets';
import type { AssessedOffer, ErrorCode, JobState, ReportLead, ReportObservation, ReportSnapshot } from '../shared/types';
import { TERMINAL_STATES } from '../shared/types';
import { finalizeQuota, localDate, mayDispatch, recordCallResult, recordCallStart, settleBudget } from './admission';
import { readConfig, type Config, type Env } from './env';
import { randomToken } from './identity';
import { IDENTIFY_LIMITS, PRICING_VERSION, RESEARCH_LIMITS, usageCost, worstCaseCallCost } from './pricing';
import {
  annotate,
  CALCULATION_VERSION,
  coverage,
  decideVerdict,
  domainOrigin,
  isPrimary,
  minimum,
  normaliseRetailer,
  percentOf,
  reportCondition,
  verdictText,
  type ObservationInput,
} from './report/compute';
import { AnthropicProvider } from './research/anthropic';
import { alnum, fingerprint, hostOf, normText, type EvidenceCorpus, type ModelObservation, type ProductIdentity, validateObservation } from './research/evidence';
import { FixtureProvider } from './research/fixture';
import { waybackObservations } from './research/wayback';
import type { AccessHints, IdentifyOutput, ProviderResult, ResearchOutput, ResearchProvider } from './research/provider';

const ACCESS_WINDOW_DAYS = 7;

/** Domains whose provider fetch recently succeeded / failed in this market. */
export async function accessHints(db: D1Database, market: string): Promise<AccessHints> {
  const since = new Date(Date.now() - ACCESS_WINDOW_DAYS * 86400_000).toISOString();
  const rows = await db.prepare(
    `SELECT domain, access_status FROM sources WHERE market = ?1 AND last_checked >= ?2 AND access_status IN ('accessible','blocked') ORDER BY last_checked DESC LIMIT 60`,
  ).bind(market, since).all<{ domain: string; access_status: string }>();
  const accessible = new Set<string>();
  const blocked = new Set<string>();
  for (const r of rows.results) (r.access_status === 'accessible' ? accessible : blocked).add(r.domain);
  for (const d of accessible) blocked.delete(d);
  return { accessible: Array.from(accessible).slice(0, 20), blocked: Array.from(blocked).slice(0, 30) };
}

/** Records provider fetch outcomes per domain (seed rows updated; new domains added as discovered). */
export async function recordSourceAccess(db: D1Database, market: string, attempts: EvidenceCorpus['fetchAttempts']): Promise<void> {
  const now = nowIso();
  const stmts: D1PreparedStatement[] = [];
  for (const a of attempts.slice(0, 20)) {
    const domain = hostOf(a.url);
    if (!domain || domain.length > 253) continue;
    const status = a.ok ? 'accessible' : 'blocked';
    const note = a.ok ? 'provider web_fetch succeeded' : `provider web_fetch failed: ${a.code ?? 'unknown'}`;
    stmts.push(
      db.prepare(`UPDATE sources SET access_status = ?3, last_checked = ?4, notes = ?5 WHERE market = ?1 AND domain = ?2`).bind(market, domain, status, now, note),
      db.prepare(
        `INSERT OR IGNORE INTO sources (id, market, domain, name, type, provenance, access_status, last_checked, notes)
         SELECT ?1, ?2, ?3, ?3, 'discovered', 'discovered', ?4, ?5, ?6 WHERE NOT EXISTS (SELECT 1 FROM sources WHERE market = ?2 AND domain = ?3)`,
      ).bind(`src_${(await fingerprint([market, domain, 'discovered'])).slice(0, 20)}`, market, domain, status, now, note),
    );
  }
  if (stmts.length) await db.batch(stmts);
}

export interface JobInput {
  market: string;
  product: string;
  price_minor: number | null;
  retailer: string | null;
}

export interface JobRow {
  id: string;
  session_digest: string;
  market: string;
  input_json: string;
  state: JobState;
  stage_detail: string | null;
  clarification_json: string | null;
  error_code: string | null;
  report_id: string | null;
  product_id: string | null;
  created_at: string;
  updated_at: string;
  deadline_at: string;
}

export class StopJob extends Error {
  constructor(public readonly outcome: 'failed' | 'cancelled', public readonly code: ErrorCode | null, message: string) {
    super(message);
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export async function getJob(db: D1Database, id: string): Promise<JobRow | null> {
  return db.prepare(`SELECT * FROM investigations WHERE id = ?1`).bind(id).first<JobRow>();
}

/** Guarded state transition: never leaves a terminal state. Returns true if the row changed. */
export async function setState(
  db: D1Database,
  id: string,
  to: JobState,
  extra: { detail?: string | null; error_code?: string | null; clarification_json?: string | null; product_id?: string | null; report_id?: string | null } = {},
): Promise<boolean> {
  const terminal = TERMINAL_STATES.map((s) => `'${s}'`).join(',');
  const res = await db
    .prepare(
      `UPDATE investigations SET state = ?2, updated_at = ?3,
         stage_detail = COALESCE(?4, stage_detail), error_code = COALESCE(?5, error_code),
         clarification_json = CASE WHEN ?2 = 'awaiting_clarification' THEN ?6 ELSE NULL END,
         product_id = COALESCE(?7, product_id), report_id = COALESCE(?8, report_id), attempt = attempt + 1
       WHERE id = ?1 AND state NOT IN (${terminal})`,
    )
    .bind(id, to, nowIso(), extra.detail ?? null, extra.error_code ?? null, extra.clarification_json ?? null, extra.product_id ?? null, extra.report_id ?? null)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

export async function logEvent(db: D1Database, jobId: string, kind: string, detail: unknown): Promise<void> {
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
  await db.prepare(`INSERT INTO investigation_log (job_id, at, kind, detail) VALUES (?1, ?2, ?3, ?4)`).bind(jobId, nowIso(), kind, text.slice(0, 2000)).run();
}

/** Terminal failure/cancel: release quota (no report delivered) and settle the budget hold. */
export async function stopJob(env: Env, jobId: string, outcome: 'failed' | 'cancelled', code: ErrorCode | null): Promise<void> {
  await setState(env.DB, jobId, outcome, { error_code: code, detail: outcome });
  await finalizeQuota(env.DB, jobId, 'released', nowIso());
  await settleBudget(env.DB, jobId, nowIso());
}

export function makeProvider(env: Env, cfg: Config, productInput: string): ResearchProvider {
  if (cfg.provider === 'fixture') return new FixtureProvider(productInput);
  if (!env.ANTHROPIC_API_KEY) throw new StopJob('failed', 'PROVIDER_UNAVAILABLE', 'Provider credential missing.');
  return new AnthropicProvider(env.ANTHROPIC_API_KEY, cfg.model);
}

/** Runs one bounded paid call with gate check, worst-case pre-charge and reconciliation. */
async function paidCall<T>(
  env: Env,
  cfg: Config,
  jobId: string,
  stage: 'identify' | 'research',
  run: (signal: AbortSignal) => Promise<ProviderResult<T>>,
): Promise<ProviderResult<T>> {
  const limits = stage === 'identify' ? IDENTIFY_LIMITS : RESEARCH_LIMITS;
  const estimate = worstCaseCallCost(cfg.model, limits);
  if (estimate === null) throw new StopJob('failed', 'PROVIDER_UNAVAILABLE', 'Pricing unknown for configured model; failing closed.');
  for (let attempt = 0; attempt < 2; attempt++) {
    const gate = await mayDispatch(env.DB, jobId);
    if (!gate.ok) {
      if (gate.reason === 'cancelled') throw new StopJob('cancelled', null, 'Cancelled.');
      throw new StopJob('failed', 'BUDGET_PAUSED', 'Research paused before dispatch.');
    }
    const callId = `call_${randomToken(12)}`;
    await recordCallStart(env.DB, { callId, jobId, stage, provider: cfg.provider, model: cfg.model, estimate, rateVersion: PRICING_VERSION, now: nowIso() });
    const started = Date.now();
    const result = await run(AbortSignal.timeout(stage === 'identify' ? 50_000 : 75_000));
    const m = result.meta;
    if (m) {
      const cost = usageCost(m.model, m.usage) ?? usageCost(cfg.model, m.usage);
      const unknownBilling = !result.ok && result.error.billing === 'unknown';
      await recordCallResult(env.DB, callId, {
        status: unknownBilling || cost === null ? 'unknown' : 'reconciled',
        model: m.model, requestId: m.requestIds.join(',') || null,
        inputTokens: m.usage.input_tokens, outputTokens: m.usage.output_tokens,
        cacheReadTokens: m.usage.cache_read_input_tokens, cacheWriteTokens: m.usage.cache_creation_input_tokens,
        searches: m.usage.web_search_requests, fetches: m.usage.web_fetch_requests,
        cost: cost ?? undefined, durationMs: Date.now() - started,
      }, nowIso());
    } else {
      const unbilled = !result.ok && result.error.billing === 'unbilled';
      await recordCallResult(env.DB, callId, { status: unbilled ? 'failed_unbilled' : 'unknown', durationMs: Date.now() - started }, nowIso());
    }
    const job = await getJob(env.DB, jobId);
    if (job) await recordSourceAccess(env.DB, job.market, result.corpus.fetchAttempts);
    await logEvent(env.DB, jobId, `${stage}_call`, {
      ok: result.ok, ms: Date.now() - started,
      error: result.ok ? null : result.error.code,
      searches: m?.usage.web_search_requests ?? null, fetches: m?.usage.web_fetch_requests ?? null,
      tool_errors: result.corpus.toolErrors, fetched: result.corpus.fetched.map((d) => hostOf(d.url)),
    });
    // One transient retry, only when the failure is provably unbilled (budget unaffected).
    if (!result.ok && result.error.retryable && result.error.billing === 'unbilled' && attempt === 0) continue;
    return result;
  }
  throw new Error('unreachable');
}

// ------------------------------------------------------------------ Stage A

export interface ResolvedProduct {
  label: string;
  brand: string | null;
  model: string | null;
  variant: string | null;
  gtin: string | null;
}

export interface CurrentOfferEvidence {
  observation: ObservationInput;
  reference_price_minor: number | null;
  availability: AssessedOffer['availability'];
}

export type IdentifyStageResult =
  | { kind: 'resolved'; product: ResolvedProduct; offer: CurrentOfferEvidence | null; leads: ReportLead[]; synthetic: boolean; searches: number; fetches: number; ms: number }
  | { kind: 'ambiguous'; candidates: { id: string; label: string; detail: string | null; product: ResolvedProduct }[]; question: string; synthetic: boolean; searches: number; fetches: number; ms: number }
  | { kind: 'stopped' };

function marketOf(code: string): Market {
  const m = marketByCode(code);
  if (!m) throw new StopJob('failed', 'INVALID_INPUT', 'Unknown market.');
  return m;
}

export async function identifyStage(env: Env, jobId: string): Promise<IdentifyStageResult> {
  return guard(env, jobId, async () => {
    const cfg = readConfig(env);
    const job = await getJob(env.DB, jobId);
    if (!job || TERMINAL_STATES.includes(job.state)) return { kind: 'stopped' } as const;
    const input = JSON.parse(job.input_json) as JobInput;
    const market = marketOf(job.market);
    const todayLocal = localDate(new Date(), market.timezone);
    await setState(env.DB, jobId, 'identifying', { detail: 'identifying' });
    const access = await accessHints(env.DB, market.code);
    const provider = makeProvider(env, cfg, input.product);
    const res = await paidCall(env, cfg, jobId, 'identify', (signal) =>
      provider.identify({ marketCode: market.code, productInput: input.product, userPriceMinor: input.price_minor, retailerHint: input.retailer, chosenCandidate: null, todayLocal, access }, signal),
    );
    if (!res.ok) throw new StopJob('failed', res.error.code === 'timeout' ? 'TIMEOUT' : 'PROVIDER_UNAVAILABLE', res.error.message);
    const out: IdentifyOutput = res.output;
    const stats = { synthetic: provider.synthetic, searches: res.meta.usage.web_search_requests, fetches: res.meta.usage.web_fetch_requests, ms: res.meta.durationMs };
    if (out.status === 'ambiguous' && out.candidates.length >= 2) {
      const candidates = out.candidates.slice(0, 5).map((c, i) => ({
        id: `c${i + 1}`,
        label: c.label,
        detail: c.distinguishing,
        product: { label: c.label, brand: c.brand, model: c.model, variant: c.variant, gtin: null },
      }));
      return { kind: 'ambiguous', candidates, question: out.question ?? 'Which exact variant do you mean?', ...stats };
    }
    if (out.status !== 'resolved' || !out.product) {
      // A valid, inconclusive outcome: the product could not be identified. Reported, not a technical failure.
      const product: ResolvedProduct = { label: input.product.slice(0, 300), brand: null, model: null, variant: null, gtin: null };
      return { kind: 'resolved', product, offer: null, leads: [{ description: out.status === 'not_a_product' ? 'The input does not look like a purchasable product.' : 'The exact product could not be identified in this market.', source_url: null, reason: out.status, amount_minor: null, currency: null, retailer: null, date: null }], ...stats };
    }
    const product: ResolvedProduct = { label: out.product.label, brand: out.product.brand, model: out.product.model, variant: out.product.variant, gtin: out.product.gtin };
    const leads: ReportLead[] = [];
    let offer: CurrentOfferEvidence | null = null;
    if (out.current_offer) {
      const v = await validateOne(out.current_offer, market, product, res.corpus, todayLocal, 'current');
      if (v.observation) offer = { observation: v.observation, reference_price_minor: out.current_offer.reference_price_minor, availability: out.current_offer.availability };
      else if (v.lead) leads.push(v.lead);
    }
    return { kind: 'resolved', product, offer, leads, ...stats };
  });
}

async function validateOne(
  o: ModelObservation,
  market: Market,
  product: ProductIdentity,
  corpus: EvidenceCorpus,
  todayLocal: string,
  kind: 'historical' | 'current',
): Promise<{ observation?: ObservationInput; lead?: ReportLead; rejected?: string }> {
  const v = validateObservation(o, { market, product, corpus, todayLocal, kind });
  if (v.status === 'rejected') return { rejected: v.reason };
  if (v.status === 'lead') {
    const date = o.date_start === o.date_end ? o.date_start : `${o.date_start} to ${o.date_end}`;
    return {
      lead: {
        description: `${o.retailer ?? o.source_name}: ${o.currency} ${(o.amount_minor / 100).toFixed(2)} (${date})`, source_url: o.source_url, reason: v.reason,
        amount_minor: o.amount_minor, currency: o.currency.toUpperCase(), retailer: o.retailer, date: kind === 'current' ? null : date,
      },
    };
  }
  const id = await fingerprint([o.source_url, o.retailer, product.model, product.variant, o.amount_minor, o.date_start, o.date_end]);
  return {
    observation: {
      id,
      amount_minor: o.amount_minor,
      currency: o.currency.toUpperCase(),
      date_start: o.date_start,
      date_end: o.date_end,
      date_precision: o.date_precision,
      retailer: o.retailer,
      source_name: o.source_name,
      source_url: o.source_url,
      source_domain: hostOf(o.source_url),
      source_type: o.source_type,
      excerpt: o.evidence_excerpt.slice(0, 600),
      retrieved_at: v.doc.retrieved_at,
      tax_basis: o.tax_basis,
      eligibility: o.eligibility,
      shipping_minor: o.shipping_minor,
    },
  };
}

// ------------------------------------------------------------------ Stage B + C

export interface ResearchStageResult {
  observations: ObservationInput[];
  alternatives: (ObservationInput & { availability: AssessedOffer['availability'] })[];
  leads: ReportLead[];
  expiry: ReportSnapshot['promotion_expiry'];
  limitations: string[];
  cache_hit: boolean;
  searches: number;
  fetches: number;
  ms: number;
  rejected: number;
}

export function canonicalKey(p: ResolvedProduct, jobId: string): string {
  // Only stable identifiers merge across investigations; uncertain identities stay job-scoped.
  if (p.gtin) return `gtin:${p.gtin}`;
  if (p.model && alnum(p.model).length >= 3) return `model:${alnum(p.brand ?? '')}|${alnum(p.model)}|${alnum(p.variant ?? '')}`;
  return `job:${jobId}`;
}

export async function upsertProduct(db: D1Database, p: ResolvedProduct, key: string): Promise<string> {
  const id = `prd_${(await fingerprint([key])).slice(0, 24)}`;
  await db
    .prepare(`INSERT OR IGNORE INTO products (id, canonical_key, brand, model, variant, gtin, condition, matching_metadata, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'new', ?7, ?8)`)
    .bind(id, key.slice(0, 400), p.brand?.slice(0, 120) ?? null, p.model?.slice(0, 160) ?? null, p.variant?.slice(0, 300) ?? null, p.gtin, JSON.stringify({ schema_version: 1, label: p.label.slice(0, 300) }), nowIso())
    .run();
  return id;
}

const RESEARCH_TTL_MS = 24 * 3600 * 1000;

export async function researchStage(env: Env, jobId: string, product: ResolvedProduct, assessedMinor: number | null, assessedRetailer: string | null, seedUrls: string[] = []): Promise<ResearchStageResult | { kind: 'stopped' }> {
  return guard(env, jobId, async () => {
    const cfg = readConfig(env);
    const job = await getJob(env.DB, jobId);
    if (!job || TERMINAL_STATES.includes(job.state)) return { kind: 'stopped' } as const;
    const market = marketOf(job.market);
    const todayLocal = localDate(new Date(), market.timezone);
    const input = JSON.parse(job.input_json) as JobInput;
    const key = canonicalKey(product, jobId);
    const productId = await upsertProduct(env.DB, product, key);
    await setState(env.DB, jobId, 'researching', { detail: 'researching', product_id: productId });

    // Stage B cache: reuse validated history for the exact product + market (original dates kept).
    const cached = await env.DB.prepare(`SELECT * FROM research_cache WHERE product_id = ?1 AND market = ?2`).bind(productId, market.code).first<{ completed_at: string; leads_json: string; expiry_json: string; limitations_json: string }>();
    if (cached && Date.now() - Date.parse(cached.completed_at) < RESEARCH_TTL_MS && !key.startsWith('job:')) {
      const rows = await env.DB.prepare(
        `SELECT o.*, e.excerpt AS excerpt FROM offers o JOIN evidence e ON e.offer_id = o.id
         WHERE o.product_id = ?1 AND o.market = ?2 AND o.verification = 'verified' AND o.source_type != 'current_offer'`,
      ).bind(productId, market.code).all<Record<string, unknown>>();
      return {
        observations: rows.results.map(rowToObservation),
        alternatives: [],
        leads: JSON.parse(cached.leads_json),
        expiry: JSON.parse(cached.expiry_json),
        limitations: [...JSON.parse(cached.limitations_json), `Historical evidence reused from research completed at ${cached.completed_at} (UTC); current offers older than one hour are not reused.`],
        cache_hit: true, searches: 0, fetches: 0, ms: 0, rejected: 0,
      };
    }

    const provider = makeProvider(env, cfg, input.product);
    const access = await accessHints(env.DB, market.code);
    const res = await paidCall(env, cfg, jobId, 'research', (signal) =>
      provider.research({ marketCode: market.code, productLabel: product.label, brand: product.brand, model: product.model, variant: product.variant, gtin: product.gtin, assessedMinor: input.price_minor ?? assessedMinor, assessedRetailer: input.retailer ?? assessedRetailer, todayLocal, access }, signal),
    );
    await setState(env.DB, jobId, 'validating', { detail: 'validating' });
    if (!res.ok) {
      // Research failure after a successful identification: deliver a partial (inconclusive) report.
      await logEvent(env.DB, jobId, 'research_failed', `${res.error.code}: ${res.error.message}`);
      return {
        observations: [], alternatives: [], leads: [], cache_hit: false, searches: res.meta?.usage.web_search_requests ?? 0, fetches: res.meta?.usage.web_fetch_requests ?? 0, ms: res.meta?.durationMs ?? 0, rejected: 0,
        expiry: { status: 'not_found', ends_local: null, source_url: null, note: null },
        limitations: [`Historical research did not complete (${res.error.code}); this report has no historical evidence.`],
      };
    }
    const out: ResearchOutput = res.output;
    const observations: ObservationInput[] = [];
    const alternatives: ResearchStageResult['alternatives'] = [];
    const leads: ReportLead[] = out.unverified_leads.map((l) => {
      const sameCurrency = (l.currency ?? '').toUpperCase() === market.currency;
      return {
        description: l.description, source_url: safeUrl(l.source_url), reason: l.reason,
        amount_minor: sameCurrency ? l.amount_minor : null, currency: sameCurrency ? market.currency : null,
        retailer: l.retailer, date: l.date,
      };
    });
    let rejected = 0;
    const seen = new Set<string>();
    for (const o of out.observations) {
      const v = await validateOne(o, market, product, res.corpus, todayLocal, 'historical');
      if (v.observation && !seen.has(v.observation.id)) { seen.add(v.observation.id); observations.push(v.observation); }
      else if (v.lead) leads.push(v.lead);
      else if (v.rejected) { rejected++; await logEvent(env.DB, jobId, 'observation_rejected', v.rejected); }
    }
    for (const o of out.current_alternatives) {
      const v = await validateOne(o, market, product, res.corpus, todayLocal, 'current');
      if (v.observation) alternatives.push({ ...v.observation, availability: o.availability });
      else if (v.lead) leads.push(v.lead);
      else rejected++;
    }
    // Internet Archive: dated structured-data prices from archived copies of discovered product pages.
    const wb = await archiveStage(env, jobId, market, product, todayLocal, [
      ...seedUrls, ...res.corpus.fetched.map((d) => d.url), ...leads.map((l) => l.source_url ?? ''),
      ...out.observations.map((o) => o.source_url), ...out.current_alternatives.map((o) => o.source_url), ...res.corpus.searchResults.map((r) => r.url),
    ]);
    for (const o of wb.observations) if (!seen.has(o.id)) { seen.add(o.id); observations.push(o); }
    const expiry = validateExpiry(out.promotion_expiry, res.corpus);
    const limitations = out.limitations.slice(0, 10).map((l) => l.slice(0, 300));
    if (res.corpus.toolErrors.length) limitations.push(`${res.corpus.toolErrors.length} source request(s) failed or were blocked (${Array.from(new Set(res.corpus.toolErrors.map((e) => e.code))).join(', ')}).`);
    limitations.push(wb.note);
    if (rejected) limitations.push(`${rejected} model-proposed price(s) were rejected by validation (wrong market, future date, non-new condition or unretrieved source).`);
    return { observations, alternatives, leads: leads.slice(0, 30), expiry, limitations, cache_hit: false, searches: res.meta.usage.web_search_requests, fetches: res.meta.usage.web_fetch_requests, ms: res.meta.durationMs, rejected };
  });
}

async function archiveStage(env: Env, jobId: string, market: Market, product: ResolvedProduct, todayLocal: string, urls: string[]): Promise<{ observations: ObservationInput[]; note: string }> {
  if (readConfig(env).provider === 'fixture') return { observations: [], note: 'Internet Archive lookup skipped (synthetic fixture run).' };
  const started = Date.now();
  try {
    const wb = await waybackObservations(urls.filter(Boolean), market, product, EVENT_CONFIG, todayLocal);
    await logEvent(env.DB, jobId, 'wayback', { ...wb.log, found: wb.observations.length, ms: Date.now() - started });
    const n = wb.observations.length;
    const note = wb.log.urls.length === 0
      ? 'Internet Archive: no retailer product page in this market was found to look up.'
      : `Internet Archive: checked ${wb.log.snapshots_fetched} archived snapshot(s) of ${wb.log.urls.join(', ')}; ${n} dated price${n === 1 ? '' : 's'} read from structured page data.`;
    return { observations: wb.observations, note };
  } catch (err) {
    await logEvent(env.DB, jobId, 'wayback_error', err instanceof Error ? err.message.slice(0, 200) : 'unknown');
    return { observations: [], note: 'Internet Archive lookup failed for this investigation.' };
  }
}

function validateExpiry(e: ResearchOutput['promotion_expiry'], corpus: EvidenceCorpus): ReportSnapshot['promotion_expiry'] {
  if (e.status !== 'documented') return { status: e.status, ends_local: null, source_url: safeUrl(e.source_url), note: e.status === 'claimed_unspecified' ? 'The retailer implies a limited-time offer but states no end date.' : null };
  const doc = e.source_url ? corpus.fetched.find((d) => d.url === e.source_url) : undefined;
  if (!doc || !e.evidence_excerpt || !e.ends_local || !normText(doc.text).includes(normText(e.evidence_excerpt))) {
    return { status: 'claimed_unspecified', ends_local: null, source_url: safeUrl(e.source_url), note: 'An end date was suggested but could not be verified in the retrieved page.' };
  }
  return { status: 'documented', ends_local: e.ends_local.slice(0, 40), source_url: e.source_url, note: `Source states: “${e.evidence_excerpt.slice(0, 200)}”. A documented end date says nothing about future prices or availability.` };
}

function safeUrl(u: string | null): string | null {
  if (!u) return null;
  try {
    const p = new URL(u);
    return p.protocol === 'https:' || p.protocol === 'http:' ? p.toString() : null;
  } catch {
    return null;
  }
}

function rowToObservation(r: Record<string, unknown>): ObservationInput {
  return {
    id: String(r.evidence_hash), amount_minor: Number(r.amount_minor), currency: String(r.currency),
    date_start: String(r.date_start), date_end: String(r.date_end), date_precision: r.date_precision as ObservationInput['date_precision'],
    retailer: (r.retailer as string) ?? null, source_name: hostOf(String(r.source_url)), source_url: String(r.source_url),
    source_domain: hostOf(String(r.source_url)), source_type: String(r.source_type), excerpt: String(r.excerpt ?? ''),
    retrieved_at: String(r.retrieved_at), tax_basis: r.tax_basis as ObservationInput['tax_basis'], eligibility: r.eligibility as ObservationInput['eligibility'],
    shipping_minor: r.shipping_minor === null ? null : Number(r.shipping_minor),
  };
}

// ------------------------------------------------------------------ Stage D

export async function reportStage(
  env: Env,
  jobId: string,
  ident: Extract<IdentifyStageResult, { kind: 'resolved' }> | { kind: 'clarified'; product: ResolvedProduct; synthetic: boolean; searches: number; fetches: number; ms: number },
  research: ResearchStageResult,
): Promise<{ reportId: string } | { kind: 'stopped' }> {
  return guard(env, jobId, async () => {
    const job = await getJob(env.DB, jobId);
    if (!job || TERMINAL_STATES.includes(job.state)) return { kind: 'stopped' } as const;
    const cfg = readConfig(env);
    const market = marketOf(job.market);
    const input = JSON.parse(job.input_json) as JobInput;
    const now = new Date();
    const asOfLocal = localDate(now, market.timezone);
    const product = ident.product;
    const identOffer = ident.kind === 'resolved' ? ident.offer : null;

    // Assessed price C: the user's advertised price if given (labelled), else the verified current offer.
    const verifiedCurrent: CurrentOfferEvidence | null = identOffer ?? lowestAlternative(research.alternatives);
    let assessed: AssessedOffer | null = null;
    if (input.price_minor !== null) {
      assessed = {
        amount_minor: input.price_minor, currency: market.currency, basis: 'user_entered', retailer: input.retailer,
        source_url: null, availability: verifiedCurrent?.availability ?? 'unknown', tax_basis: 'unknown', as_of: now.toISOString(), as_of_local_date: asOfLocal,
        verified_match: verifiedCurrent ? (verifiedCurrent.observation.amount_minor === input.price_minor ? 'matches' : 'differs') : 'not_found',
        verified_amount_minor: verifiedCurrent?.observation.amount_minor ?? null,
      };
    } else if (verifiedCurrent) {
      const o = verifiedCurrent.observation;
      assessed = {
        amount_minor: o.amount_minor, currency: o.currency, basis: 'verified_offer', retailer: o.retailer, source_url: o.source_url,
        availability: verifiedCurrent.availability, tax_basis: o.tax_basis, as_of: o.retrieved_at, as_of_local_date: asOfLocal,
        verified_match: 'matches', verified_amount_minor: o.amount_minor,
      };
    }

    const annotated = annotate(research.observations, assessed, market.code, EVENT_CONFIG, asOfLocal);
    const primary = annotated.filter(isPrimary);
    const cov = coverage(primary, EVENT_CONFIG, asOfLocal);
    const c = assessed?.amount_minor ?? null;
    const verdict = decideVerdict(c, primary, cov);
    const overall = c !== null ? minimum(c, primary) : null;
    const prev = c !== null ? minimum(c, primary.filter((o) => o.window === 'previous_event')) : null;
    const off = c !== null ? minimum(c, primary.filter((o) => o.window === 'offseason')) : null;
    const retailerKey = normaliseRetailer(assessed?.retailer ?? null);
    const same = c !== null && retailerKey ? minimum(c, primary.filter((o) => normaliseRetailer(o.retailer) === retailerKey)) : null;
    const ref = identOffer?.reference_price_minor ?? null;
    const advertised = ref && assessed && ref > assessed.amount_minor
      ? { reference_minor: ref, percent: percentOf(ref - assessed.amount_minor, ref), note: 'Retailer-stated reference ("was") price. This is not verified savings.' }
      : null;
    const alternatives: ReportObservation[] = research.alternatives
      .filter((a) => !identOffer || a.id !== identOffer.observation.id)
      .map((a) => ({ ...a, window: 'current_event', comparable: true, comparability_notes: [] }));
    if (identOffer && input.price_minor !== null) alternatives.unshift({ ...identOffer.observation, window: 'current_event', comparable: true, comparability_notes: ['Independently verified current offer.'] });

    const limitations = [...research.limitations];
    if (!assessed) limitations.push('No current price was entered and no current offer could be verified.');
    if (assessed?.basis === 'user_entered') limitations.push('The assessed price is the price you entered; it is used as a hypothetical comparison, not a confirmed retail observation.');
    if (cov.months_missing.length) limitations.push(`No comparable evidence for: ${cov.months_missing.join(', ')}.`);
    if (overall && primary.filter((o) => o.amount_minor === overall.minimum_minor).length === 1 && verdict === 'cheaper_before') limitations.push('The lower price is supported by a single source; it has not been independently corroborated.');
    if (asOfLocal > EVENT_CONFIG.offseason_end) limitations.push(`Fixed comparison window for edition ${EVENT_CONFIG.edition}; assessed as of ${asOfLocal} (${market.timezone}).`);

    const snapshot: ReportSnapshot = {
      schema_version: 1,
      calculation_version: CALCULATION_VERSION,
      synthetic_fixture: ident.synthetic,
      generated_at: now.toISOString(),
      market: { code: market.code, name: market.name, currency: market.currency, timezone: market.timezone },
      window_config: { ...EVENT_CONFIG },
      product: { label: product.label, brand: product.brand, model: product.model, variant: product.variant, gtin: product.gtin, condition: 'new' },
      assessed,
      verdict,
      verdict_text: verdictText(verdict, assessed, overall, cov),
      condition: reportCondition(assessed, primary, cov),
      previous_event: prev,
      offseason: off,
      overall,
      same_retailer: same,
      advertised_discount: advertised,
      observations: annotated.sort((a, b) => a.date_start.localeCompare(b.date_start)),
      current_alternatives: alternatives,
      leads: [...(ident.kind === 'resolved' ? ident.leads : []), ...research.leads].slice(0, 40),
      coverage: cov,
      promotion_expiry: research.expiry,
      limitations,
      research: {
        model: ident.synthetic ? 'synthetic-fixture' : cfg.model,
        searches: ident.searches + research.searches,
        fetches: ident.fetches + research.fetches,
        duration_ms: Date.now() - Date.parse(job.created_at),
        cache_hit: research.cache_hit,
      },
    };

    const productId = await upsertProduct(env.DB, product, canonicalKey(product, jobId));
    const evidenceIds = await persistEvidence(env.DB, jobId, productId, market.code, research, identOffer);
    if (!research.cache_hit && !canonicalKey(product, jobId).startsWith('job:') && !ident.synthetic) {
      await env.DB.prepare(
        `INSERT INTO research_cache (product_id, market, completed_at, leads_json, expiry_json, limitations_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(product_id, market) DO UPDATE SET completed_at = excluded.completed_at, leads_json = excluded.leads_json, expiry_json = excluded.expiry_json, limitations_json = excluded.limitations_json`,
      ).bind(productId, market.code, now.toISOString(), JSON.stringify(research.leads.slice(0, 30)), JSON.stringify(research.expiry), JSON.stringify(research.limitations.slice(0, 10))).run();
    }
    const reportId = `rpt_${randomToken(18)}`;
    await env.DB.batch([
      env.DB.prepare(`INSERT OR IGNORE INTO reports (id, investigation_id, snapshot, calculation_version, evidence_ids, generated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
        .bind(reportId, jobId, JSON.stringify(snapshot), CALCULATION_VERSION, JSON.stringify(evidenceIds), now.toISOString()),
    ]);
    const stored = await env.DB.prepare(`SELECT id FROM reports WHERE investigation_id = ?1`).bind(jobId).first<{ id: string }>();
    const finalId = stored?.id ?? reportId;
    const changed = await setState(env.DB, jobId, 'complete', { detail: 'complete', report_id: finalId, product_id: productId });
    if (changed) await finalizeQuota(env.DB, jobId, 'completed', nowIso());
    else await finalizeQuota(env.DB, jobId, 'released', nowIso()); // cancelled meanwhile
    await settleBudget(env.DB, jobId, nowIso());
    return { reportId: finalId };
  });
}

function lowestAlternative(alts: ResearchStageResult['alternatives']): CurrentOfferEvidence | null {
  const pub = alts.filter((a) => a.eligibility === 'public');
  if (!pub.length) return null;
  const best = pub.reduce((a, b) => (b.amount_minor < a.amount_minor ? b : a));
  return { observation: best, reference_price_minor: null, availability: best.availability };
}

async function persistEvidence(db: D1Database, jobId: string, productId: string, market: string, research: ResearchStageResult, offer: CurrentOfferEvidence | null): Promise<string[]> {
  if (research.cache_hit && !offer) return research.observations.map((o) => o.id);
  const rows: { o: ObservationInput; type: string }[] = research.cache_hit ? [] : research.observations.map((o) => ({ o, type: o.source_type }));
  if (offer) rows.push({ o: offer.observation, type: 'current_offer' });
  for (const a of research.alternatives) rows.push({ o: a, type: 'current_offer' });
  const stmts: D1PreparedStatement[] = [];
  for (const { o, type } of rows) {
    const offerId = `ofr_${o.id.slice(0, 24)}`;
    stmts.push(
      db.prepare(
        `INSERT OR IGNORE INTO offers (id, product_id, market, source_id, source_url, retailer, amount_minor, currency, date_start, date_end, date_precision, retrieved_at, shipping_minor, tax_basis, eligibility, condition, availability, source_type, verification, evidence_hash)
         VALUES (?1, ?2, ?3, (SELECT id FROM sources WHERE market = ?3 AND (?4 = domain OR ?4 LIKE '%.' || domain) LIMIT 1), ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 'new', 'unknown', ?16, 'verified', ?17)`,
      ).bind(offerId, productId, market, o.source_domain, o.source_url, o.retailer, o.amount_minor, o.currency, o.date_start, o.date_end, o.date_precision, o.retrieved_at, o.shipping_minor, o.tax_basis, o.eligibility, type, o.id),
      db.prepare(
        `INSERT OR IGNORE INTO evidence (id, offer_id, source_reference, excerpt, retrieved_at, validation_notes, lineage, fingerprint) VALUES (?1, (SELECT id FROM offers WHERE evidence_hash = ?2), ?3, ?4, ?5, ?6, ?7, ?2)`,
      ).bind(`evd_${o.id.slice(0, 24)}`, o.id, o.source_url, o.excerpt.slice(0, 600), o.retrieved_at, JSON.stringify(['excerpt bound to retrieved page', 'amount, product, date and market checked']), JSON.stringify({ job: jobId, origin: domainOrigin(o.source_url) })),
    );
  }
  if (stmts.length) await db.batch(stmts);
  return rows.map((r) => r.o.id);
}

/** Wraps a stage: StopJob → terminal state + quota release; unexpected errors → technical failure. */
async function guard<T>(env: Env, jobId: string, fn: () => Promise<T>): Promise<T | { kind: 'stopped' }> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof StopJob) {
      await stopJob(env, jobId, err.outcome, err.code);
    } else {
      await logEvent(env.DB, jobId, 'stage_error', err instanceof Error ? err.message.slice(0, 300) : 'unknown');
      await stopJob(env, jobId, 'failed', 'INTERNAL');
    }
    return { kind: 'stopped' };
  }
}
