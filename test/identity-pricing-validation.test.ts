import { describe, expect, it } from 'vitest';
import { expandIPv6, networkBucket, quotaDigest, readSessionCookie, trustedClientAddress } from '../src/worker/identity';
import { IDENTIFY_LIMITS, RESEARCH_LIMITS, usageCost, worstCaseCallCost, worstCaseJobCost } from '../src/worker/pricing';
import { checkProduct, safePublicUrl } from '../src/worker/validation';
import { verifyTurnstile } from '../src/worker/turnstile';

describe('network bucket', () => {
  it('normalises IPv4 and IPv6 /64', () => {
    expect(networkBucket('203.0.113.7')).toBe('v4:203.0.113.7');
    expect(networkBucket('2001:db8:abcd:12:1:2:3:4')).toBe('v6:2001:0db8:abcd:0012::/64');
    expect(networkBucket('2001:DB8:ABCD:12::99')).toBe('v6:2001:0db8:abcd:0012::/64');
    expect(networkBucket('[2001:db8:abcd:12::1]')).toBe('v6:2001:0db8:abcd:0012::/64');
    expect(networkBucket('::ffff:198.51.100.4')).toBe('v4:198.51.100.4');
    expect(networkBucket('fe80::1%eth0')).toBe('v6:fe80:0000:0000:0000::/64');
  });
  it('rejects garbage', () => {
    expect(networkBucket('999.1.1.1')).toBeNull();
    expect(networkBucket('not-an-ip')).toBeNull();
    expect(networkBucket('1::2::3')).toBeNull();
    expect(expandIPv6('1:2:3:4:5:6:7:8:9')).toBeNull();
  });
  it('only trusts CF-Connecting-IP, never forwarded headers', () => {
    const forged = new Request('https://x/', { headers: { 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '1.2.3.4', forwarded: 'for=1.2.3.4' } });
    expect(trustedClientAddress(forged, false)).toBeNull();
    const real = new Request('https://x/', { headers: { 'cf-connecting-ip': '198.51.100.9', 'x-forwarded-for': '1.2.3.4' } });
    expect(trustedClientAddress(real, false)).toBe('198.51.100.9');
  });
  it('stores only versioned HMAC digests, never the address', async () => {
    const d = await quotaDigest('secret', 1, 'v4:198.51.100.9');
    expect(d.startsWith('k1.')).toBe(true);
    expect(d).not.toContain('198');
    expect(await quotaDigest('secret', 2, 'v4:198.51.100.9')).not.toBe(d);
  });
  it('parses only well-formed session cookies', () => {
    const ok = 'a'.repeat(43);
    expect(readSessionCookie(new Request('https://x/', { headers: { cookie: `foo=1; dc_sid=${ok}` } }))).toBe(ok);
    expect(readSessionCookie(new Request('https://x/', { headers: { cookie: `dc_sid=../../etc` } }))).toBeNull();
  });
});

describe('pricing', () => {
  it('fails closed for unknown models', () => {
    expect(worstCaseJobCost('mystery-model')).toBeNull();
    expect(usageCost('mystery-model', { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, web_search_requests: 0, web_fetch_requests: 0 })).toBeNull();
  });
  it('worst case bounds a typical call and fits many jobs in the daily cap', () => {
    const job = worstCaseJobCost('claude-haiku-5-5')!;
    expect(job).toBeGreaterThan(0);
    expect(job * 5).toBeLessThan(25_000_000); // the global concurrency ceiling (5) of worst-case holds fits within NZ$25
    const typical = usageCost('claude-haiku-5-5', { input_tokens: 60_000, output_tokens: 4000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, web_search_requests: 6, web_fetch_requests: 3 })!;
    expect(typical).toBeLessThan(worstCaseCallCost('claude-haiku-5-5', RESEARCH_LIMITS)!);
  });
  it('web searches are charged at $10/1000 converted conservatively', () => {
    const c = usageCost('claude-haiku-5-5', { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, web_search_requests: 1, web_fetch_requests: 5 })!;
    expect(c).toBe(19_500); // US$0.01 × 1.95 = NZ$0.0195 ; fetch has no fee
  });
  it('long-prompt tier is applied conservatively', () => {
    const small = usageCost('claude-haiku-5-5', { input_tokens: 100_000, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, web_search_requests: 0, web_fetch_requests: 0 })!;
    const big = usageCost('claude-haiku-5-5', { input_tokens: 100_001, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, web_search_requests: 0, web_fetch_requests: 0 })!;
    expect(big).toBeGreaterThan(small * 4);
  });
  it('identify is cheaper than research', () => expect(worstCaseCallCost('claude-haiku-5-5', IDENTIFY_LIMITS)!).toBeLessThan(worstCaseCallCost('claude-haiku-5-5', RESEARCH_LIMITS)!));
});

describe('input safety', () => {
  it.each([
    'javascript:alert(1)', 'file:///etc/passwd', 'http://localhost/x', 'http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data',
    'http://[::1]/', 'http://10.0.0.1/', 'http://user:pw@shop.nz/', 'http://shop.nz:8080/', 'http://metadata.google.internal/', 'ftp://shop.nz/x',
    'http://2130706433/', 'http://0x7f000001/', 'http://router.lan/', 'data:text/html,hi',
  ])('rejects unsafe link %s', (u) => {
    expect(safePublicUrl(u)).toBeNull();
    expect(checkProduct(u).ok).toBe(false);
  });
  it('accepts public retailer links and plain names', () => {
    expect(checkProduct('https://www.pbtech.co.nz/product/ABC123').ok).toBe(true);
    expect(checkProduct('Sony WH-1000XM6 headphones').ok).toBe(true);
    expect(checkProduct('4548736132580').ok).toBe(true);
  });
  it('enforces length limits', () => {
    expect(checkProduct('a'.repeat(513)).ok).toBe(false);
    expect(checkProduct('https://shop.nz/' + 'a'.repeat(2100)).ok).toBe(false);
  });
  it('blocks obvious personal information', () => {
    expect(checkProduct('iPhone for jane@example.com').ok).toBe(false);
    expect(checkProduct('call me +64 21 555 1234').ok).toBe(false);
  });
});

describe('turnstile', () => {
  it('fails closed', async () => {
    expect(await verifyTurnstile(undefined, 'tok')).toBe(false);
    expect(await verifyTurnstile('s', '')).toBe(false);
    const boom = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
    expect(await verifyTurnstile('s', 'tok', boom)).toBe(false);
    const no = (async () => new Response(JSON.stringify({ success: false }))) as unknown as typeof fetch;
    expect(await verifyTurnstile('s', 'tok', no)).toBe(false);
    const yes = (async () => new Response(JSON.stringify({ success: true }))) as unknown as typeof fetch;
    expect(await verifyTurnstile('s', 'tok', yes)).toBe(true);
  });
});
