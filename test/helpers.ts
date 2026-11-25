import { env } from 'cloudflare:workers';
import { admit, type AdmissionRequest } from '../src/worker/admission';
import { randomToken } from '../src/worker/identity';

export const DAY = '2026-11-25';
export const CAP = 25_000_000;

export function req(over: Partial<AdmissionRequest> = {}): AdmissionRequest {
  return {
    jobId: `inv_${randomToken(18)}`, sessionDigest: 'sess-a', quotaDigest: 'k1.net-a', quotaKeyVersion: 1, idempotencyKey: randomToken(12),
    market: 'NZ', inputJson: JSON.stringify({ market: 'NZ', product: 'FIXTURE-CHEAPER phone', price_minor: 79900, retailer: null }),
    costReserved: 1_000_000, dayKey: DAY, dailyCap: CAP, quotaTotal: 10, globalConcurrency: 5,
    now: '2026-11-25T01:00:00.000Z', deadlineAt: '2099-01-01T00:00:00.000Z', ...over,
  };
}

export async function bucket(digest: string) {
  return env.DB.prepare(`SELECT completed, reserved FROM quota_buckets WHERE digest = ?1`).bind(digest).first<{ completed: number; reserved: number }>();
}

export async function budget(day = DAY) {
  return env.DB.prepare(`SELECT spent_estimate, outstanding_reserved, cap, state FROM daily_budget WHERE day_key = ?1`).bind(day).first<{ spent_estimate: number; outstanding_reserved: number; cap: number; state: string }>();
}

export { admit, env };
