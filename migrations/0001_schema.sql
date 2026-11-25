-- DealCheck schema v1. UTC ISO-8601 timestamps for system events; observation dates are
-- market-local calendar dates (YYYY-MM-DD) with explicit precision.
PRAGMA foreign_keys = ON;

CREATE TABLE markets (
  code TEXT PRIMARY KEY CHECK (length(code) = 2),
  name TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  minor_units INTEGER NOT NULL DEFAULT 2 CHECK (minor_units BETWEEN 0 AND 3),
  languages TEXT NOT NULL,              -- JSON array of BCP-47 tags
  timezone TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  event_config TEXT NOT NULL,           -- JSON: comparison windows for this edition
  seed_version TEXT NOT NULL
);

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  market TEXT NOT NULL REFERENCES markets(code),
  domain TEXT NOT NULL CHECK (length(domain) BETWEEN 3 AND 253),
  name TEXT NOT NULL CHECK (length(name) <= 200),
  type TEXT NOT NULL CHECK (type IN ('deal_community','price_comparison','price_history','retailer','discovered')),
  provenance TEXT NOT NULL CHECK (provenance IN ('seed','discovered')),
  access_status TEXT NOT NULL DEFAULT 'unknown' CHECK (access_status IN ('unknown','accessible','partial','blocked','not_permitted')),
  last_checked TEXT,
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 2000),
  seed_version TEXT,
  UNIQUE (market, domain, type)
);
CREATE INDEX sources_market_status ON sources(market, access_status);

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  canonical_key TEXT NOT NULL UNIQUE CHECK (length(canonical_key) <= 400),
  brand TEXT CHECK (brand IS NULL OR length(brand) <= 120),
  model TEXT CHECK (model IS NULL OR length(model) <= 160),
  variant TEXT CHECK (variant IS NULL OR length(variant) <= 300),
  gtin TEXT CHECK (gtin IS NULL OR (length(gtin) BETWEEN 8 AND 14)),
  condition TEXT NOT NULL DEFAULT 'new',
  matching_metadata TEXT,              -- JSON (schema_version inside)
  created_at TEXT NOT NULL
);

CREATE TABLE offers (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  market TEXT NOT NULL REFERENCES markets(code),
  source_id TEXT REFERENCES sources(id),
  source_url TEXT NOT NULL CHECK (length(source_url) <= 2048),
  retailer TEXT CHECK (retailer IS NULL OR length(retailer) <= 200),
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  date_start TEXT NOT NULL,
  date_end TEXT NOT NULL CHECK (date_end >= date_start),
  date_precision TEXT NOT NULL CHECK (date_precision IN ('day','interval','month')),
  retrieved_at TEXT NOT NULL,
  shipping_minor INTEGER CHECK (shipping_minor IS NULL OR shipping_minor >= 0),
  tax_basis TEXT NOT NULL CHECK (tax_basis IN ('included','excluded','unknown')),
  eligibility TEXT NOT NULL CHECK (eligibility IN ('public','member','coupon','trade_in','financing','bundle','restricted','unknown')),
  condition TEXT NOT NULL CHECK (condition IN ('new','used','refurbished','open_box','unknown')),
  availability TEXT NOT NULL CHECK (availability IN ('in_stock','out_of_stock','preorder','unknown')),
  source_type TEXT NOT NULL,
  verification TEXT NOT NULL CHECK (verification IN ('verified','unverified')),
  evidence_hash TEXT NOT NULL UNIQUE
);
CREATE INDEX offers_lookup ON offers(market, product_id, date_start, verification);

CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  offer_id TEXT NOT NULL REFERENCES offers(id),
  source_reference TEXT NOT NULL CHECK (length(source_reference) <= 2048),
  excerpt TEXT CHECK (excerpt IS NULL OR length(excerpt) <= 600),
  retrieved_at TEXT NOT NULL,
  validation_notes TEXT,               -- JSON array
  lineage TEXT,                        -- JSON: job id, provider call id
  fingerprint TEXT NOT NULL UNIQUE
);

CREATE TABLE sessions (
  digest TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen TEXT NOT NULL
);

CREATE TABLE investigations (
  id TEXT PRIMARY KEY,
  session_digest TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 64),
  market TEXT NOT NULL REFERENCES markets(code),
  input_json TEXT NOT NULL CHECK (length(input_json) <= 4096),
  product_id TEXT REFERENCES products(id),
  state TEXT NOT NULL CHECK (state IN ('queued','identifying','awaiting_clarification','researching','validating','complete','failed','cancelled')),
  stage_detail TEXT,
  clarification_json TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  report_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deadline_at TEXT NOT NULL,
  UNIQUE (session_digest, idempotency_key)
);
CREATE INDEX investigations_session ON investigations(session_digest, created_at);
CREATE INDEX investigations_state ON investigations(state, updated_at);

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  investigation_id TEXT NOT NULL UNIQUE REFERENCES investigations(id),
  snapshot TEXT NOT NULL,
  calculation_version TEXT NOT NULL,
  evidence_ids TEXT NOT NULL,          -- JSON array
  generated_at TEXT NOT NULL
);

-- Shared research cache (24 h TTL) per exact product + market. Independent of session receipts.
CREATE TABLE research_cache (
  product_id TEXT NOT NULL REFERENCES products(id),
  market TEXT NOT NULL REFERENCES markets(code),
  completed_at TEXT NOT NULL,
  leads_json TEXT NOT NULL,
  expiry_json TEXT NOT NULL,
  limitations_json TEXT NOT NULL,
  PRIMARY KEY (product_id, market)
);

-- Admission ledger (authoritative; all writes via guarded D1 batches).
CREATE TABLE quota_buckets (
  digest TEXT PRIMARY KEY,
  key_version INTEGER NOT NULL,
  completed INTEGER NOT NULL DEFAULT 0 CHECK (completed >= 0),
  reserved INTEGER NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE daily_budget (
  day_key TEXT PRIMARY KEY,            -- Pacific/Auckland calendar date
  spent_estimate INTEGER NOT NULL DEFAULT 0 CHECK (spent_estimate >= 0),        -- micro-NZD
  outstanding_reserved INTEGER NOT NULL DEFAULT 0 CHECK (outstanding_reserved >= 0), -- micro-NZD
  cap INTEGER NOT NULL CHECK (cap >= 0),                                         -- micro-NZD
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','paused'))
);

CREATE TABLE reservations (
  job_id TEXT PRIMARY KEY REFERENCES investigations(id),
  quota_digest TEXT NOT NULL REFERENCES quota_buckets(digest),
  day_key TEXT NOT NULL REFERENCES daily_budget(day_key),
  cost_reserved INTEGER NOT NULL CHECK (cost_reserved >= 0),  -- micro-NZD
  quota_state TEXT NOT NULL CHECK (quota_state IN ('active','completed','released')),
  budget_state TEXT NOT NULL CHECK (budget_state IN ('held','settled')),
  admit_token TEXT NOT NULL,
  settle_token TEXT,
  budget_token TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX reservations_active ON reservations(quota_state, quota_digest);
CREATE INDEX reservations_budget ON reservations(budget_state, day_key);

CREATE TABLE provider_usage (
  call_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES investigations(id),
  stage TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  request_id TEXT,
  input_tokens INTEGER, output_tokens INTEGER,
  cache_read_tokens INTEGER, cache_write_tokens INTEGER,
  web_search_requests INTEGER, web_fetch_requests INTEGER,
  currency TEXT NOT NULL DEFAULT 'NZD',
  cost_estimate INTEGER NOT NULL CHECK (cost_estimate >= 0),   -- micro-NZD; worst case until reconciled
  rate_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('dispatched','reconciled','failed_unbilled','unknown')),
  duration_ms INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX provider_usage_job ON provider_usage(job_id);

-- Owner-only operational switches (changed with authenticated `wrangler d1 execute`).
CREATE TABLE controls (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO controls (key, value, updated_at) VALUES ('research_paused', 'false', '2026-11-25T00:00:00Z');

-- Investigation log: source access failures and timings (no secrets, no visitor identity).
CREATE TABLE investigation_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  at TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT CHECK (detail IS NULL OR length(detail) <= 2000)
);
CREATE INDEX investigation_log_job ON investigation_log(job_id);
