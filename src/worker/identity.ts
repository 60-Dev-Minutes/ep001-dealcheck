// Privacy-minimised network bucket + opaque session receipts. Raw addresses are never stored or logged.

/** Client address from Cloudflare's trusted ingress header only. Forwarded headers are ignored. */
export function trustedClientAddress(req: Request, allowLocalFallback: boolean): string | null {
  const ip = req.headers.get('cf-connecting-ip');
  if (ip && ip.length <= 64) return ip.trim();
  return allowLocalFallback ? '127.0.0.1' : null;
}

/** IPv4 as-is; IPv6 → canonical /64 prefix; IPv4-mapped IPv6 → IPv4. Returns null if unparseable. */
export function networkBucket(address: string): string | null {
  const a = address.trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  const v4 = parseIPv4(a);
  if (v4) return `v4:${v4}`;
  const groups = expandIPv6(a);
  if (!groups) return null;
  // IPv4-mapped (::ffff:a.b.c.d)
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const hi = groups[6] ?? 0;
    const lo = groups[7] ?? 0;
    return `v4:${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return `v6:${groups.slice(0, 4).map((g) => g.toString(16).padStart(4, '0')).join(':')}::/64`;
}

function parseIPv4(s: string): string | null {
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return parts.join('.');
}

export function expandIPv6(s: string): number[] | null {
  if (!/^[0-9a-f:.]+$/.test(s) || !s.includes(':')) return null;
  let tail: number[] = [];
  let str = s;
  const lastColon = str.lastIndexOf(':');
  const maybeV4 = str.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    const v4 = parseIPv4(maybeV4);
    if (!v4) return null;
    const p = v4.split('.').map(Number) as [number, number, number, number];
    tail = [(p[0] << 8) | p[1], (p[2] << 8) | p[3]];
    str = str.slice(0, lastColon + 1) + '0:0';
  }
  const halves = str.split('::');
  if (halves.length > 2) return null;
  const parse = (h: string) => (h === '' ? [] : h.split(':'));
  const head = parse(halves[0] ?? '');
  const rest = halves.length === 2 ? parse(halves[1] ?? '') : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 && head.length !== 8) return null;
  if (halves.length === 2 && missing < 1) return null;
  const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest];
  if (all.length !== 8 || all.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  const nums = all.map((g) => parseInt(g, 16));
  if (tail.length) nums.splice(6, 2, ...tail);
  return nums;
}

const enc = new TextEncoder();

export async function hmacDigest(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return b64url(new Uint8Array(sig));
}

export async function sha256(message: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(message));
  return b64url(new Uint8Array(d));
}

export async function quotaDigest(secret: string, keyVersion: number, bucket: string): Promise<string> {
  return `k${keyVersion}.` + (await hmacDigest(secret, `quota|v${keyVersion}|${bucket}`));
}

export function randomToken(bytes = 32): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return b64url(b);
}

export function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const SESSION_COOKIE = 'dc_sid';
export const SESSION_TTL_DAYS = 30;

export function readSessionCookie(req: Request): string | null {
  const header = req.headers.get('cookie') ?? '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === SESSION_COOKIE) {
      const val = v.join('=');
      return /^[A-Za-z0-9_-]{32,64}$/.test(val) ? val : null;
    }
  }
  return null;
}

export function sessionCookieHeader(token: string, secure: boolean): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_TTL_DAYS * 86400}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
}

/** Session digest stored server-side: HMAC so a database leak does not reveal usable cookies. */
export async function sessionDigest(secret: string, token: string): Promise<string> {
  return hmacDigest(secret, `session|${token}`);
}
