import seed from '../../seed/sources.v1.json';

export type MarketCode = string; // data-driven; validated against the registry

export interface Market {
  code: MarketCode;
  name: string;
  currency: string;
  languages: string[];
  timezone: string;
  aliases: string[];
  /** Approximate location hint for provider web search (country codes vary in support). */
  search_location?: { country?: string; city?: string; timezone?: string };
}

export interface EventConfig {
  edition: string;
  previous_event_date: string;
  offseason_start: string;
  offseason_end: string;
  current_event_start: string;
}

export const SEED_VERSION: string = seed.seed_version;
export const EVENT_CONFIG: EventConfig = seed.event_config;
export const MARKETS: Market[] = seed.markets as Market[];
export const DEFAULT_MARKET: MarketCode = 'NZ';

/** Number separator convention used to interpret user-entered prices. */
export type DecimalConvention = 'dot' | 'comma';

const CONVENTION_BY_LANGUAGE: Record<string, DecimalConvention> = { en: 'dot', de: 'comma', et: 'comma' };

export function marketByCode(code: string): Market | undefined {
  const upper = code.trim().toUpperCase();
  return MARKETS.find((m) => m.code === upper || m.aliases.includes(upper));
}

export function decimalConvention(market: Market): DecimalConvention {
  const primary = market.languages[0]?.split('-')[0] ?? 'en';
  return CONVENTION_BY_LANGUAGE[primary] ?? 'dot';
}

export function retailerHints(code: MarketCode): string[] {
  return (seed.retailer_hints as Record<string, string[]>)[code] ?? [];
}

export function vocabulary(code: MarketCode): string[] {
  return (seed.vocabulary as Record<string, string[]>)[code] ?? [];
}

export function seedSources(code: MarketCode): { domain: string; name: string; type: string }[] {
  return seed.sources.filter((s) => s.market === code);
}

/** Currency tokens that unambiguously identify one market's currency. */
const UNIQUE_CURRENCY_TOKENS: Record<string, string[]> = {
  USD: ['US$', 'USD'],
  NZD: ['NZ$', 'NZD'],
  AUD: ['AU$', 'A$', 'AUD'],
};

/** Currency symbols a user may type for each currency (ambiguous ones included). */
const CURRENCY_SYMBOLS: Record<string, string[]> = {
  USD: ['US$', 'USD', '$'],
  NZD: ['NZ$', 'NZD', '$'],
  AUD: ['AU$', 'A$', 'AUD', '$'],
  EUR: ['EUR', '€'],
};

export function uniqueCurrencyTokens(currency: string): string[] {
  return UNIQUE_CURRENCY_TOKENS[currency] ?? [];
}

export function currencySymbols(currency: string): string[] {
  return CURRENCY_SYMBOLS[currency] ?? [currency];
}

export const ALL_CURRENCY_TOKENS: string[] = Array.from(
  new Set(Object.values(CURRENCY_SYMBOLS).flat().concat(['£', 'GBP', 'CA$', 'CAD', 'C$', 'kr', 'zł', 'CHF', '¥', 'JPY'])),
).sort((a, b) => b.length - a.length);

/** Country-code TLD suffixes per market, used to reject foreign-market sources. */
export const MARKET_TLDS: Record<string, string[]> = {
  US: ['.us'],
  NZ: ['.nz'],
  AU: ['.au'],
  EE: ['.ee'],
  DE: ['.de'],
};

/** ccTLDs that clearly belong to some other country (non-exhaustive, conservative). */
export const FOREIGN_CCTLDS = [
  '.uk', '.ca', '.ie', '.fr', '.it', '.es', '.nl', '.be', '.at', '.ch', '.pl', '.se', '.no', '.dk', '.fi',
  '.lv', '.lt', '.ru', '.jp', '.cn', '.in', '.sg', '.hk', '.za', '.br', '.mx', '.us', '.nz', '.au', '.ee', '.de',
];
