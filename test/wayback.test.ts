import { describe, expect, it } from 'vitest';
import { EVENT_CONFIG, marketByCode } from '../src/shared/markets';
import { candidateUrls, extractStructuredPrice, selectSnapshots, waybackObservations } from '../src/worker/research/wayback';

const NZ = marketByCode('NZ')!;
const product = { brand: 'Samsung', model: 'LS49FG912EEXXY', variant: '49"', gtin: null };
const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;

describe('extractStructuredPrice', () => {
  it('reads JSON-LD Product.offers', () => {
    const html = ld({ '@context': 'https://schema.org', '@type': 'Product', name: 'X', offers: { '@type': 'Offer', price: '1099.00', priceCurrency: 'NZD', availability: 'https://schema.org/InStock' } });
    expect(extractStructuredPrice(html, 'NZD')).toMatchObject({ amount_minor: 109900, currency: 'NZD', availability: 'in_stock', aggregate: false });
  });
  it('reads @graph and AggregateOffer lowPrice', () => {
    const html = ld({ '@graph': [{ '@type': 'WebPage' }, { '@type': 'Product', offers: { '@type': 'AggregateOffer', lowPrice: 1169, highPrice: 1500, priceCurrency: 'NZD' } }] });
    expect(extractStructuredPrice(html, 'NZD')).toMatchObject({ amount_minor: 116900, aggregate: true });
  });
  it('reads Open Graph product meta', () => {
    const html = '<meta property="product:price:amount" content="1288.00"><meta property="product:price:currency" content="NZD">';
    expect(extractStructuredPrice(html, 'NZD')?.amount_minor).toBe(128800);
  });
  it('refuses ambiguous or foreign prices and offers outside a Product', () => {
    expect(extractStructuredPrice(ld({ '@type': 'Product', offers: [{ '@type': 'Offer', price: '999', priceCurrency: 'NZD' }, { '@type': 'Offer', price: '1099', priceCurrency: 'NZD' }] }), 'NZD')).toBeNull();
    expect(extractStructuredPrice(ld({ '@type': 'Product', offers: { '@type': 'Offer', price: '999', priceCurrency: 'AUD' } }), 'NZD')).toBeNull();
    expect(extractStructuredPrice(ld({ '@type': 'Offer', price: '5', priceCurrency: 'NZD' }), 'NZD')).toBeNull();
    expect(extractStructuredPrice(ld({ '@type': 'Product', offers: { '@type': 'Offer', price: '1,099', priceCurrency: 'NZD' } }), 'NZD')).toBeNull();
    expect(extractStructuredPrice('<script type="application/ld+json">{broken</script>', 'NZD')).toBeNull();
  });
});

describe('candidateUrls', () => {
  it('keeps in-market product pages, ranks model matches, drops listings and foreign sites', () => {
    const urls = candidateUrls([
      'https://www.pbtech.co.nz/hot-deals/filter/peripherals/monitors',
      'https://www.amazon.com.au/dp/B0XYZ',
      'https://www.example.co.nz/about',
      'https://www.pbtech.co.nz/product/MONSAM74910/Samsung-Odyssey-G91F-49-LS49FG912EEXXY',
      'https://www.pbtech.co.nz/product/MONSAM74910/Samsung-Odyssey-G91F-49-LS49FG912EEXXY#reviews',
      'https://web.archive.org/web/2026/https://x.co.nz/p',
      'not a url',
    ], NZ, product, 3);
    expect(urls[0]).toBe('https://www.pbtech.co.nz/product/MONSAM74910/Samsung-Odyssey-G91F-49-LS49FG912EEXXY');
    expect(urls).not.toContain('https://www.pbtech.co.nz/hot-deals/filter/peripherals/monitors');
    expect(urls.some((u) => u.includes('amazon.com.au'))).toBe(false);
    expect(urls.filter((u) => u.includes('MONSAM74910'))).toHaveLength(1);
  });
});

describe('selectSnapshots', () => {
  it('prioritises the previous event day (market-local) then one per month, newest first', () => {
    const snaps = [
      { timestamp: '20251127120000', original: 'x' }, // 2025-11-28 01:00 NZDT → event day locally
      { timestamp: '20251127130000', original: 'x' }, // same local day, dropped
      { timestamp: '20260110000000', original: 'x' },
      { timestamp: '20260115000000', original: 'x' }, // same month, dropped
      { timestamp: '20260301000000', original: 'x' },
      { timestamp: '20261201000000', original: 'x' }, // after as-of, dropped
      { timestamp: '2025112', original: 'bad' },
    ];
    const pick = selectSnapshots(snaps, EVENT_CONFIG, 'Pacific/Auckland', '2026-11-25', 5);
    expect(pick.map((s) => s.timestamp)).toEqual(['20251127120000', '20260301000000', '20260110000000']);
  });
});

describe('waybackObservations', () => {
  it('produces dated, archive-backed observations from structured data only', async () => {
    const page = (price: string, name = 'Samsung Odyssey G91F 49" LS49FG912EEXXY') =>
      `<html><title>${name}</title>${ld({ '@type': 'Product', name, sku: 'LS49FG912EEXXY', offers: { '@type': 'Offer', price, priceCurrency: 'NZD' } })}<body>${name}</body></html>`;
    const calls: string[] = [];
    const fake = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/cdx/search/cdx')) {
        return Response.json([['timestamp', 'original', 'statuscode', 'mimetype'], ['20251127120000', 'https://www.pbtech.co.nz/product/MONSAM74910/x', '200', 'text/html'], ['20260301000000', 'https://www.pbtech.co.nz/product/MONSAM74910/x', '200', 'text/html'], ['20260601000000', 'https://www.pbtech.co.nz/product/MONSAM74910/x', '200', 'text/html']]);
      }
      if (url.includes('20251127120000id_')) return new Response(page('1199.00'));
      if (url.includes('20260301000000id_')) return new Response(page('1169.00'));
      if (url.includes('20260601000000id_')) return new Response(page('999.00', 'Some other monitor 27"')); // wrong product
      return new Response('nope', { status: 404 });
    }) as typeof fetch;
    const r = await waybackObservations(['https://www.pbtech.co.nz/product/MONSAM74910/x'], NZ, product, EVENT_CONFIG, '2026-11-25', fake);
    expect(r.observations.map((o) => [o.date_start, o.amount_minor, o.source_type])).toEqual([
      ['2025-11-28', 119900, 'archive_snapshot'],
      ['2026-03-01', 116900, 'archive_snapshot'],
    ]);
    expect(r.observations[0]!.source_url).toBe('https://web.archive.org/web/20251127120000/https://www.pbtech.co.nz/product/MONSAM74910/x');
    expect(r.observations[0]!.source_domain).toBe('pbtech.co.nz');
    expect(r.observations[0]!.excerpt).toMatch(/JSON-LD Offer.price = 1199.00 NZD/);
    expect(calls.every((u) => u.startsWith('https://web.archive.org/'))).toBe(true);
  });
  it('degrades gracefully when the archive is unavailable', async () => {
    const down = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
    const r = await waybackObservations(['https://www.pbtech.co.nz/product/1/x-LS49FG912EEXXY'], NZ, product, EVENT_CONFIG, '2026-11-25', down);
    expect(r.observations).toEqual([]);
    expect(r.log.misses[0]).toMatch(/unavailable/);
  });
});

import { idPrefix } from '../src/worker/research/wayback';
describe('idPrefix', () => {
  it('derives a product-id prefix only when a slug follows', () => {
    expect(idPrefix('https://www.pbtech.co.nz/product/MONSAM74910/Samsung-Odyssey')).toBe('www.pbtech.co.nz/product/MONSAM74910/');
    expect(idPrefix('https://pp.co.nz/product/ab55408/')).toBeNull();
    expect(idPrefix('https://shop.nz/about')).toBeNull();
  });
});

import { identityText } from '../src/worker/research/wayback';
describe('archive identity', () => {
  it('ignores related-product mentions in body text and isRelatedTo', () => {
    const html = `<title>Samsung Odyssey OLED G95SC</title>${ld({ '@type': 'Product', name: 'Odyssey OLED G95SC', sku: 'LS49CG954SEXXY', isRelatedTo: { '@type': 'Product', name: 'Odyssey G91F LS49FG912EEXXY' }, offers: { '@type': 'Offer', price: '1999', priceCurrency: 'AUD' } })}<body>Compare with Odyssey G91F LS49FG912EEXXY</body>`;
    const t = identityText(html).toLowerCase();
    expect(t).toContain('g95sc');
    expect(t).not.toContain('g91f');
  });
});
