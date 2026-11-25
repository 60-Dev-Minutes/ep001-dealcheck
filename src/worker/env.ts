export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  INVESTIGATION: Workflow<{ jobId: string }>;
  RL_ADMISSION: RateLimit;
  RL_POLL: RateLimit;
  RL_INVALID: RateLimit;

  ENVIRONMENT: string; // production | development | test
  RESEARCH_ENABLED: string;
  PROVIDER: string; // anthropic | fixture (fixture refused in production)
  ANTHROPIC_MODEL: string;
  DAILY_BUDGET_NZD: string;
  QUOTA_TOTAL: string;
  GLOBAL_CONCURRENCY: string;
  BUDGET_TIMEZONE: string;
  QUOTA_KEY_VERSION: string;
  TURNSTILE_SITE_KEY: string;
  PUBLICATION_URL: string;

  // Secrets
  ANTHROPIC_API_KEY?: string;
  QUOTA_HMAC_SECRET?: string;
  SESSION_SECRET?: string;
  TURNSTILE_SECRET_KEY?: string;
}

export interface Config {
  production: boolean;
  researchEnabled: boolean;
  provider: 'anthropic' | 'fixture';
  model: string;
  dailyCapMicroNzd: number;
  quotaTotal: number;
  globalConcurrency: number;
  budgetTimezone: string;
  quotaKeyVersion: number;
}

export function readConfig(env: Env): Config {
  const production = env.ENVIRONMENT === 'production';
  const provider = env.PROVIDER === 'fixture' && !production ? 'fixture' : 'anthropic';
  const cap = Number(env.DAILY_BUDGET_NZD);
  return {
    production,
    researchEnabled: env.RESEARCH_ENABLED === 'true',
    provider,
    model: env.ANTHROPIC_MODEL || 'claude-haiku-5-5',
    // Fail closed: an unparseable cap means zero budget.
    dailyCapMicroNzd: Number.isFinite(cap) && cap > 0 ? Math.floor(cap * 1_000_000) : 0,
    quotaTotal: positiveInt(env.QUOTA_TOTAL, 10),
    globalConcurrency: positiveInt(env.GLOBAL_CONCURRENCY, 5),
    budgetTimezone: env.BUDGET_TIMEZONE || 'Pacific/Auckland',
    quotaKeyVersion: positiveInt(env.QUOTA_KEY_VERSION, 1),
  };
}

function positiveInt(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
