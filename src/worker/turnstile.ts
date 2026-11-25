const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Server-side Turnstile verification. Fails closed on any error. Visitor IP is not sent. */
export async function verifyTurnstile(secret: string | undefined, token: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  if (!secret || !token || token.length > 2048) return false;
  try {
    const body = new FormData();
    body.append('secret', secret);
    body.append('response', token);
    const res = await fetcher(VERIFY_URL, { method: 'POST', body, signal: AbortSignal.timeout(5000) });
    if (!res.ok) return false;
    const data = (await res.json()) as { success?: boolean; action?: string };
    return data.success === true;
  } catch {
    return false;
  }
}
