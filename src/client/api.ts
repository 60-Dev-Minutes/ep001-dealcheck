// Thin, typed wrappers around the DealCheck Worker API. Same-origin only.
import type {
  ApiError,
  CreateInvestigationRequest,
  InvestigationStatus,
  MarketInfo,
  QuotaInfo,
  RecentCheck,
  ReportSnapshot,
} from '../shared/types';

/**
 * A failed API call. `network` is true when no structured response was received
 * (connection dropped, gateway page, etc.) — the request may or may not have reached the server,
 * so a retry should reuse the same idempotency key.
 */
export class ApiFailure extends Error {
  readonly status: number;
  readonly error: ApiError;
  readonly network: boolean;
  constructor(status: number, error: ApiError, network: boolean) {
    super(error.message);
    this.name = 'ApiFailure';
    this.status = status;
    this.error = error;
    this.network = network;
  }
}

const NETWORK_ERROR: ApiError = {
  code: 'INTERNAL',
  message: 'Could not reach DealCheck. Check your connection and try again.',
  retryable: true,
};

function isApiError(x: unknown): x is ApiError {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return typeof o.code === 'string' && typeof o.message === 'string';
}

export function isAbort(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(path, { ...init, credentials: 'same-origin', cache: 'no-store', headers });
  } catch (e) {
    if (isAbort(e)) throw e;
    throw new ApiFailure(0, NETWORK_ERROR, true);
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch (e) {
    if (isAbort(e)) throw e;
    data = null;
  }
  if (!res.ok) {
    if (isApiError(data)) {
      throw new ApiFailure(res.status, { code: data.code, message: data.message, retryable: Boolean(data.retryable) }, false);
    }
    throw new ApiFailure(
      res.status,
      { code: 'INTERNAL', message: `DealCheck returned an unexpected response (HTTP ${res.status}). Please try again.`, retryable: true },
      true,
    );
  }
  if (data === null || typeof data !== 'object') {
    throw new ApiFailure(res.status, { code: 'INTERNAL', message: 'DealCheck returned an unreadable response. Please try again.', retryable: true }, true);
  }
  return data as T;
}

export function getMarkets(signal?: AbortSignal): Promise<{ markets: MarketInfo[] }> {
  return call('/api/markets', { signal });
}

export function getRecent(signal?: AbortSignal): Promise<{ recent: RecentCheck[] }> {
  return call('/api/recent', { signal });
}

export function getQuota(signal?: AbortSignal): Promise<QuotaInfo> {
  return call('/api/quota', { signal });
}

export function createInvestigation(body: CreateInvestigationRequest): Promise<{ id: string; state: string }> {
  return call('/api/investigations', { method: 'POST', body: JSON.stringify(body) });
}

const enc = encodeURIComponent;

export function getInvestigation(id: string, signal?: AbortSignal): Promise<InvestigationStatus> {
  return call(`/api/investigations/${enc(id)}`, { signal });
}

export function cancelInvestigation(id: string): Promise<InvestigationStatus> {
  return call(`/api/investigations/${enc(id)}/cancel`, { method: 'POST', body: '{}' });
}

export function clarifyInvestigation(id: string, candidateId: string): Promise<InvestigationStatus> {
  return call(`/api/investigations/${enc(id)}/clarify`, { method: 'POST', body: JSON.stringify({ candidate_id: candidateId }) });
}

export async function getReport(id: string, signal?: AbortSignal): Promise<ReportSnapshot> {
  const snap = await call<ReportSnapshot>(`/api/reports/${enc(id)}`, { signal });
  if (snap.schema_version !== 1) {
    throw new ApiFailure(200, { code: 'INTERNAL', message: 'This report uses a format this page does not understand. Please reload.', retryable: false }, false);
  }
  return snap;
}
