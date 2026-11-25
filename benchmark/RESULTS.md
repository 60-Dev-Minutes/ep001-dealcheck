# DealCheck benchmark — Episode 001

Frozen selection: [products.v1.json](products.v1.json) (20 products, 4 per market, chosen before any product research).
Runtime: the DealCheck Worker code under local `wrangler dev` with the real Anthropic API (Claude Haiku 5.5, web search + web fetch)
and the Internet Archive stage. Raw outputs are in `results/`. Ambiguous items: the runner picks the first candidate when asked.

## Runs

| Run | Code | Items | Notes |
|---|---|---|---|
| 1 | 73242b3…f6bd666 | 1 (+1 aborted) | Paid smoke (#5) and an aborted run (local server reloaded mid-job). Not counted. |
| 2 | a505000 | 20 | 7 technical failures from two bugs: provider rejects country code EE (4), one malformed identification field failed the whole job (3). |
| 2b | 11fff908 | 7 | Rerun of the 7 failed items after both fixes. 7/7 completed. |

The table and metrics below combine run 2 (13 completed items) with run 2b (the 7 reruns). Fixes deployed after these runs —
history without a current price (4913ad04), stricter archive identity, and stronger ambiguity prompting — are **not** reflected here.

## Results (20 products)

| Metric | Target | Result | Status |
|---|---|---|---|
| Market support | 5/5 | 5/5 markets with correct currency (EE only after the fix) | met (after fix) |
| Product identity | ≥95% (≥19/20) | 15/20 specific inputs resolved to the named product; the 5 deliberately ambiguous inputs (#4, #8, #12, #16, #20) were resolved to one variant without asking, which the spec counts as not correct → **15/20 (75%)**. Not independently reviewed. | **not met** |
| Price observation accuracy | ≥95% of emitted | 20 verified observations emitted; reference sample of 1 independently re-checked against the archived page (#7, 100percent.co.nz NZ$723.00, 2026-02-06): correct. Remaining 19 not independently reviewed. | **unverified** (sample 1/20) |
| Historical evidence coverage | ≥60% (≥12/20) with ≥1 verified comparable | **2/20 (10%)** | **not met** |
| Rich history coverage | ≥40% (≥8/20) with ≥3 | **1/20 (5%)** | **not met** |
| Fabricated observations | 0 | 0 found in audited output (every verified price is bound to a retrieved page excerpt or archived structured data); full audit not performed | 0 in sample |
| Cross-market errors | 0 | 0 found (foreign-market prices were rejected by validation; full audit not performed) | 0 in sample |
| Median duration | ≤60 s | **53 s** (cold runs; no cache hits; 0 timeouts) | met |
| Mean AI cost per completed investigation | ≤NZ$0.25 | **NZ$0.30** conservative ledger estimate (long-prompt tier applied to cumulative tokens; FX 1.95). At base Haiku rates ≈ NZ$0.09–0.10. Failed-attempt spend: NZ$0.13 total (7 failures). | conservative estimate **not met**; likely met at actual billing (unverified) |

Verdicts: 1 cheaper before, 1 limited history, 18 insufficient evidence (4 of them had verified prices but no verified current
price to compare against — shown since 4913ad04).

### Why coverage is low
- Anthropic's web fetch returned `url_not_accessible` for most retailer and price-comparison pages (e.g. PriceMe, Noel Leeming, PriceSpy).
  DealCheck does not bypass these restrictions, so search snippets remain unverified leads (shown to users, never used in the verdict).
- The Internet Archive stage produced the only rich result (#7: 5 verified prices, all from archived structured data), but most retail
  product pages have no captures in the window.

## Per-product results

| # | Mkt | Input | Run | State | Identified as | Verdict | Verified obs | Comparable | Unverified prices | Secs |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | US | Sony WH-1000XM5 wireless noise cancell | 2 | complete | Sony WH-1000XM5 Wireless Noise Cancelling Over-t | limited_history | 1 | 1 | 0 | 64 |
| 2 | US | DEWALT DCD771C2 20V MAX cordless drill | 2 | complete | DEWALT DCD771C2 20V MAX Lithium-Ion 1/2" Compact | insufficient_evidence | 0 | 0 | 6 | 33 |
| 3 | US | Ninja AF101 Air Fryer 4 quart | 2 | complete | Ninja AF101 4-qt Air Fryer, Black/Gray (high glo | insufficient_evidence | 0 | 0 | 9 | 58 |
| 4 | US | Apple iPad | 2 | complete | Apple iPad (A16, 11-inch class) 128GB Wi-Fi | insufficient_evidence | 0 | 0 | 0 | 73 |
| 5 | NZ | Apple AirPods Pro 2 USB-C | 2 | failed | — | — | 0 | 0 | 0 | 13 |
| 5 | NZ | Apple AirPods Pro 2 USB-C | 2b | complete | Apple AirPods Pro (2nd generation) with MagSafe  | insufficient_evidence | 3 | 0 | 9 | 53 |
| 6 | NZ | Ryobi ONE+ 18V brushless drill driver  | 2 | complete | Ryobi 18V ONE+ Brushless Drill Driver Tool Only  | insufficient_evidence | 0 | 0 | 0 | 38 |
| 7 | NZ | Breville the Barista Express BES870BSS | 2 | complete | Breville The Barista Express Manual Espresso Mac | cheaper_before | 5 | 5 | 8 | 63 |
| 8 | NZ | Fisher & Paykel 8kg front loader washi | 2 | failed | — | — | 0 | 0 | 0 | 8 |
| 8 | NZ | Fisher & Paykel 8kg front loader washi | 2b | complete | Fisher & Paykel 8kg Series 3 Front Loader Washer | insufficient_evidence | 0 | 0 | 9 | 43 |
| 9 | AU | Nintendo Switch OLED Model white | 2 | complete | Nintendo Switch (OLED Model) White Console, 64GB | insufficient_evidence | 0 | 0 | 11 | 53 |
| 10 | AU | Makita DHP485Z 18V brushless hammer dr | 2 | complete | Makita DHP485Z 18V Li-ion Brushless Hammer Drive | insufficient_evidence | 0 | 0 | 8 | 53 |
| 11 | AU | Dyson V15 Detect Absolute | 2 | failed | — | — | 0 | 0 | 0 | 18 |
| 11 | AU | Dyson V15 Detect Absolute | 2b | complete | Dyson V15 Detect Absolute cordless stick vacuum, | insufficient_evidence | 3 | 0 | 10 | 53 |
| 12 | AU | Philips air fryer | 2 | complete | Philips 3000 Series 7.2L XXL Airfryer (NA342/00) | insufficient_evidence | 6 | 0 | 15 | 68 |
| 13 | EE | Apple iPhone 16 128GB | 2 | failed | — | — | 0 | 0 | 0 | 1 |
| 13 | EE | Apple iPhone 16 128GB | 2b | complete | Apple iPhone 16 128GB Black | insufficient_evidence | 0 | 0 | 7 | 43 |
| 14 | EE | Bosch Professional GSR 12V-15 akutrell | 2 | failed | — | — | 0 | 0 | 0 | 1 |
| 14 | EE | Bosch Professional GSR 12V-15 akutrell | 2b | complete | Bosch GSR 12V-15 Professional, solo (no battery, | insufficient_evidence | 0 | 0 | 3 | 63 |
| 15 | EE | Philips Airfryer HD9252/90 | 2 | failed | — | — | 0 | 0 | 0 | 1 |
| 15 | EE | Philips Airfryer HD9252/90 | 2b | complete | Philips Airfryer Essential L HD9252/90 (4.1 L, b | insufficient_evidence | 0 | 0 | 6 | 48 |
| 16 | EE | Xiaomi robottolmuimeja | 2 | failed | — | — | 0 | 0 | 0 | 1 |
| 16 | EE | Xiaomi robottolmuimeja | 2b | complete | Xiaomi Robot Vacuum S40 (EU, wet/dry, manual emp | insufficient_evidence | 0 | 0 | 2 | 86 |
| 17 | DE | Sony PlayStation 5 Slim Digital Editio | 2 | complete | Sony PlayStation 5 Slim Digital Edition 825 GB,  | insufficient_evidence | 0 | 0 | 0 | 68 |
| 18 | DE | Bosch Professional GSR 18V-55 Akku-Boh | 2 | complete | Bosch Professional GSR 18V-55, solo (ohne Akku/L | insufficient_evidence | 0 | 0 | 6 | 43 |
| 19 | DE | De'Longhi Magnifica S ECAM 22.110.B Ka | 2 | complete | De'Longhi Magnifica S ECAM 22.110.B Kaffeevollau | insufficient_evidence | 2 | 0 | 11 | 53 |
| 20 | DE | Samsung Fernseher 55 Zoll | 2 | complete | Samsung 55" Crystal UHD DU7199 (2024), LED/LCD 4 | insufficient_evidence | 0 | 0 | 6 | 53 |

*Run 2b rows supersede the failed run-2 rows for the same item. "Unverified prices" are prices seen in search snippets or unreadable pages.*
