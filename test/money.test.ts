import { describe, expect, it } from 'vitest';
import { marketByCode } from '../src/shared/markets';
import { amountsInText, formatMoney, parseUserPrice } from '../src/shared/money';

const NZ = marketByCode('NZ')!;
const DE = marketByCode('DE')!;
const EE = marketByCode('EE')!;
const US = marketByCode('US')!;

describe('parseUserPrice', () => {
  it.each([
    ['799', 79900], ['799.99', 79999], ['799.9', 79990], ['1,299.99', 129999], ['1,299', 129900], ['$1,299.00', 129900],
    ['NZ$ 49.95', 4995], ['NZD 1 299', 129900], ['799,99', 79999], ['1,234,567', 123456700],
  ])('NZ %s -> %i', (raw, minor) => expect(parseUserPrice(raw, NZ)).toEqual({ kind: 'ok', minor }));

  it.each([
    ['799,99', 79999], ['1.299,99', 129999], ['1.299', 129900], ['€ 49,95', 4995], ['49,95 €', 4995], ['799,-', 79900], ['1 299,50', 129950],
  ])('DE %s -> %i', (raw, minor) => expect(parseUserPrice(raw, DE)).toEqual({ kind: 'ok', minor }));

  it('EE uses decimal comma', () => expect(parseUserPrice('12,50', EE)).toEqual({ kind: 'ok', minor: 1250 }));

  it('flags ambiguous three-digit groups against local convention', () => {
    expect(parseUserPrice('1.299', NZ).kind).toBe('ambiguous');
    expect(parseUserPrice('1,299', DE).kind).toBe('ambiguous');
  });

  it.each(['0', '0.00', '-5', 'abc', '1.2.3,4,5', '12.345', '7.999', '1e5', '', '   '])('rejects or empties %s', (raw) => {
    expect(['invalid', 'empty', 'ambiguous']).toContain(parseUserPrice(raw, NZ).kind);
  });

  it('rejects more than two decimals', () => expect(parseUserPrice('9.999', US).kind).not.toBe('ok'));

  it('rejects foreign currency tokens', () => {
    expect(parseUserPrice('€ 499', NZ).kind).toBe('currency_mismatch');
    expect(parseUserPrice('AU$ 499', NZ).kind).toBe('currency_mismatch');
    expect(parseUserPrice('$499', DE).kind).toBe('currency_mismatch');
  });

  it('rejects absurd amounts', () => expect(parseUserPrice('99999999999', NZ).kind).toBe('invalid'));
});

describe('amountsInText', () => {
  it('reads both conventions', () => {
    const s = amountsInText('Jetzt 1.299,99 € statt 1.499,- (NZ$ 799.00) 2026-07-10');
    expect(s.has(129999)).toBe(true);
    expect(s.has(149900)).toBe(true);
    expect(s.has(79900)).toBe(true);
  });
  it('does not read model digits glued to letters as a different price', () => {
    const s = amountsInText('FX-100 for 749.00');
    expect(s.has(74900)).toBe(true);
    expect(s.has(74999)).toBe(false);
  });
});

describe('formatMoney', () => {
  it('formats from integer minor units', () => expect(formatMoney(129999, 'NZD')).toBe('NZD 1,299.99'));
  it('handles negatives', () => expect(formatMoney(-5, 'EUR')).toBe('-EUR 0.05'));
});
