import type { ApiError, ErrorCode } from '../shared/types';

export const CSP = [
  "default-src 'self'",
  "script-src 'self' https://challenges.cloudflare.com",
  "frame-src https://challenges.cloudflare.com https://60devminutes.substack.com",
  "connect-src 'self'",
  "img-src 'self' data:",
  "style-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  'upgrade-insecure-requests',
].join('; ');

export function withSecurityHeaders(res: Response, opts: { noStore?: boolean; noIndex?: boolean } = {}): Response {
  const out = new Response(res.body, res);
  const h = out.headers;
  h.set('Content-Security-Policy', CSP);
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  h.set('X-Frame-Options', 'DENY');
  h.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Strict-Transport-Security', 'max-age=31536000');
  // Default to no-store; public endpoints (markets, recent checks) set their own short cache policy.
  if (opts.noStore && !h.has('Cache-Control')) h.set('Cache-Control', 'no-store');
  if (opts.noIndex) h.set('X-Robots-Tag', 'noindex, nofollow');
  return out;
}

const RETRYABLE: Partial<Record<ErrorCode, boolean>> = { BUSY: true, RATE_LIMITED: true, PROVIDER_UNAVAILABLE: true, TURNSTILE_FAILED: true, TIMEOUT: true, INTERNAL: true };

export function apiError(code: ErrorCode, message: string, status: number, retryable = RETRYABLE[code] ?? false): Response {
  const body: ApiError = { code, message, retryable };
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export function json(data: unknown, status = 200, cache = 'no-store'): Response {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cache } });
}

/** State-changing requests must come from this origin (CSRF defence in addition to SameSite=Strict). */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  const site = req.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') return false;
  if (!origin) return false;
  return origin === new URL(req.url).origin;
}
