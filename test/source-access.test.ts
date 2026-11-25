import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { accessHints, recordSourceAccess } from '../src/worker/pipeline';
import { researchSystem } from '../src/worker/research/prompts';

describe('source access learning', () => {
  it('updates seed sources, adds discovered domains and feeds hints into the prompt', async () => {
    await recordSourceAccess(env.DB, 'NZ', [
      { url: 'https://www.pricespy.co.nz/x', ok: false, code: 'url_not_accessible' },
      { url: 'https://www.newshop.co.nz/p', ok: true, code: null },
    ]);
    const seed = await env.DB.prepare(`SELECT access_status, provenance FROM sources WHERE market='NZ' AND domain='pricespy.co.nz'`).first();
    expect(seed).toEqual({ access_status: 'blocked', provenance: 'seed' });
    const disc = await env.DB.prepare(`SELECT access_status, provenance, type FROM sources WHERE market='NZ' AND domain='newshop.co.nz'`).first();
    expect(disc).toEqual({ access_status: 'accessible', provenance: 'discovered', type: 'discovered' });
    const hints = await accessHints(env.DB, 'NZ');
    expect(hints).toEqual({ accessible: ['newshop.co.nz'], blocked: ['pricespy.co.nz'] });
    expect(await accessHints(env.DB, 'DE')).toEqual({ accessible: [], blocked: [] });
    const prompt = researchSystem({ marketCode: 'NZ', productLabel: 'x', brand: null, model: null, variant: null, gtin: null, assessedMinor: null, assessedRetailer: null, todayLocal: '2026-11-25', access: hints });
    expect(prompt).toContain('Fetch recently failed');
    expect(prompt).toContain('pricespy.co.nz');
  });
});
