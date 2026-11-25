# DealCheck

**Was it cheaper before Black Friday?** DealCheck is an experimental, AI-assisted price investigation tool from
[60 Dev Minutes](https://60devminutes.substack.com/), Episode 001. Pick a market, enter a product (name, model
number, barcode or retailer link) and optionally the advertised deal price. DealCheck researches dated historical
offers for that exact product in that market and shows the evidence, not just a conclusion.

Live (when released): https://dealcheck.kratt.nz

## The experiment

Build and ship a working public application with **no proprietary price dataset** and **at most 60 minutes of
human involvement**. AI agents may work longer; their time and cost are measured separately. The initial database
contains only a directory of candidate deal communities and price-comparison sites
([`seed/sources.v1.json`](seed/sources.v1.json)), not price histories. Results, including failures, will be
published on the newsletter.

## How an investigation works

1. **Identify** the exact product and price-relevant variant (asks you to choose if it is ambiguous).
2. **Establish the current offer**: your entered price (labelled as yours) or a current offer verified on a retailer page.
3. **Research** dated historical offers in the selected market using Claude with web search and web fetch.
4. **Validate** every proposed price deterministically. A price counts only if a retrieved page contains the
   exact quoted excerpt with that amount, mentions the exact model, states the date, and belongs to the selected
   market. Search snippets and unreadable pages are shown as *research leads*, never used in calculations.
5. **Calculate** in application code with integer minor currency units. The model does no arithmetic and picks no verdicts.

### Verdicts

| Verdict | Meaning |
|---|---|
| Cheaper before | A verified comparable earlier offer was strictly lower. |
| Price matched before | No lower offer was found, and at least one earlier offer was equal. |
| Lowest observed price | Below all verified comparisons, with adequate coverage (≥3 dated observations over ≥90 days from ≥2 independent sources, or a ≥90-day verified series). |
| Limited history | Below the available comparisons, but coverage is thin. |
| Insufficient evidence | No verified comparable history, or no usable current price. |

Comparison windows for this edition (market-local dates): previous Black Friday **28 Nov 2025**, off-season
**29 Nov 2025 – 26 Nov 2026** (only observations strictly before the assessed offer), current event from **27 Nov 2026**.
Foreign-market prices are never converted or compared. Member-only, coupon, trade-in and bundle offers are kept separate.

## Markets

US (USD), New Zealand (NZD), Australia (AUD), Estonia (EUR), Germany (EUR). Markets are data-driven from the seed file.

## Access and limits

No account. Each network gets a small number of free investigations for the pilot, shared by everyone on that
network (it is not a per-person allowance). A daily research budget pauses new investigations when reached.
Product text you enter is sent to an AI research provider (Anthropic); please don't include personal information.

## Stack

One Cloudflare Worker (Hono API + static React/Vite client), D1 (SQLite) for evidence, reports and the admission
ledger, Cloudflare Workflows for durable jobs, Turnstile, and the Anthropic Claude API with server-side web search and
web fetch.

## Development

```sh
npm install
cp .dev.vars.example .dev.vars   # placeholders; uses the synthetic fixture provider by default
npm run db:migrate:local
npm run dev                      # http://localhost:8787
npm test                         # unit + D1 integration + workflow tests (synthetic fixtures only)
npm run typecheck
npm run secret-scan
```

`npm run seed:gen` regenerates `migrations/0002_seed.sql` from `seed/sources.v1.json`.

Tests and local development use a clearly labelled **synthetic fixture provider**. Fixture reports are marked
"synthetic test data" and the fixture provider is refused in production.

## Benchmark

[`benchmark/products.v1.json`](benchmark/products.v1.json) is the 20-product benchmark (four per market), frozen
before any product research. `scripts/benchmark.mjs` runs it against a DealCheck instance and stores raw outputs.

## Disclaimer

DealCheck is a consumer research experiment, not a guarantee of the lowest price, product availability or future
discounts. An earlier lower price does not by itself mean an advertisement was misleading.
