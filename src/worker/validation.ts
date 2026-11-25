import { z } from 'zod';
import { marketByCode, type Market } from '../shared/markets';
import { parseUserPrice } from '../shared/money';
import type { ApiError } from '../shared/types';
import type { JobInput } from './pipeline';

export const MAX_PRODUCT_TEXT = 512;
export const MAX_PRODUCT_URL = 2048;

export const CreateBody = z
  .object({
    market: z.string().min(2).max(3),
    product: z.string().min(1).max(MAX_PRODUCT_URL),
    price: z.string().max(32).optional(),
    retailer: z.string().max(100).optional(),
    condition: z.literal('new').optional(),
    idempotency_key: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
    turnstile_token: z.string().max(2048),
  })
  .strict();

export type Validated = { ok: true; market: Market; input: JobInput } | { ok: false; error: ApiError; status: 400 };

const bad = (code: ApiError['code'], message: string): Validated => ({ ok: false, status: 400, error: { code, message, retryable: false } });

export function validateCreate(body: z.infer<typeof CreateBody>): Validated {
  const market = marketByCode(body.market);
  if (!market) return bad('INVALID_INPUT', 'Choose one of the supported markets.');
  const product = checkProduct(body.product);
  if (!product.ok) return bad('INVALID_INPUT', product.message);
  let priceMinor: number | null = null;
  if (body.price !== undefined) {
    const p = parseUserPrice(body.price, market);
    if (p.kind === 'currency_mismatch') return bad('MARKET_MISMATCH', p.reason);
    if (p.kind === 'ambiguous') return bad('AMBIGUOUS_PRICE', p.reason);
    if (p.kind === 'invalid') return bad('INVALID_INPUT', p.reason);
    if (p.kind === 'ok') priceMinor = p.minor;
  }
  const retailer = body.retailer?.trim() || null;
  if (retailer && (hasControl(retailer) || looksPersonal(retailer))) return bad('INVALID_INPUT', 'Retailer name contains unsupported characters.');
  return { ok: true, market, input: { market: market.code, product: product.value, price_minor: priceMinor, retailer } };
}

function hasControl(s: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(s);
}

function looksPersonal(s: string): boolean {
  return /[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(s) || /\+?\d[\d\s-]{8,}\d/.test(s.replace(/\b\d{8,14}\b/g, ''));
}

export function checkProduct(raw: string): { ok: true; value: string; kind: 'text' | 'url' } | { ok: false; message: string } {
  const s = raw.trim();
  if (!s) return { ok: false, message: 'Enter a product name, model number, barcode or product link.' };
  if (hasControl(s)) return { ok: false, message: 'The product text contains unsupported characters.' };
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^:]+:\d/.test(s)) {
    if (s.length > MAX_PRODUCT_URL) return { ok: false, message: `Links can be at most ${MAX_PRODUCT_URL} characters.` };
    const u = safePublicUrl(s);
    if (!u) return { ok: false, message: 'Only public http(s) retailer product links are accepted.' };
    return { ok: true, value: u, kind: 'url' };
  }
  if (s.length > MAX_PRODUCT_TEXT) return { ok: false, message: `Product text can be at most ${MAX_PRODUCT_TEXT} characters.` };
  if (looksPersonal(s)) return { ok: false, message: 'Please do not include personal information (emails or phone numbers).' };
  return { ok: true, value: s, kind: 'text' };
}

/** Accepts only public http(s) URLs: no credentials, IP literals, local/internal names or unusual ports. */
export function safePublicUrl(s: string): string | null {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== '80' && u.port !== '443') return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes('.') || host.endsWith('.')) return null;
  if (/^\d+(\.\d+){3}$/.test(host) || host.startsWith('[') || /^0x/i.test(host) || /^\d+$/.test(host)) return null;
  if (/(^|\.)(localhost|local|internal|intranet|corp|home|lan|localdomain|invalid|test|example|onion)$/.test(host)) return null;
  if (host === 'metadata.google.internal' || host.endsWith('.arpa')) return null;
  u.hash = '';
  return u.toString();
}
