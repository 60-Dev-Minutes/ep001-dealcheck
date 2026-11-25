# DealCheck

**Public project specification · v1.0**

60 Dev Minutes / Episode 001

## 1. The challenge

Black Friday promotions are often presented as exceptional purchasing opportunities. Yet a large advertised discount does not necessarily mean a product is cheaper than it was during the rest of the year.

DealCheck is an experimental AI-powered product pricing research application. Its purpose is to investigate actual historical offers and help consumers answer one question:

> Could I have bought this exact product for less at any point since the previous Black Friday?

The engineering challenge is to build a functioning, publicly usable application with no proprietary historical pricing dataset and no more than 60 minutes of human involvement. AI agents may work for longer; their execution time and costs are measured separately.

## 2. Product scope

The application will offer a simple, mobile-friendly interface in English. A visitor selects a shopping market, enters a product name, model number or retailer product link, and optionally enters the advertised deal price. No account or registration is required. A limited number of free investigations will be available during the experiment.

| Market | Currency | Research languages |
|---|---|---|
| United States | USD | English |
| New Zealand | NZD | English |
| Australia | AUD | English |
| Estonia | EUR | Estonian, English |
| Germany | EUR | German, English |

The shopping market determines which retailers, currencies and historical offers are relevant. A price from another country is not a valid historical comparison merely because the product is identical or the currency can be converted.

## 3. How an investigation works

1. **Identify the product.** Resolve the exact model, generation, configuration and other price-relevant variants. Ask for clarification if the product is ambiguous.
2. **Establish the current offer.** Use the supplied price or identify a relevant current offer. Distinguish user-supplied prices from independently confirmed prices.
3. **Investigate historical evidence.** Search relevant deal communities, price comparison services, retailer promotions and other accessible, dated sources in the selected market.
4. **Discover additional sources.** Allow the AI to independently identify relevant retailers and local research sources beyond the initial directory.
5. **Validate observations.** Match product, market, currency, date and offer conditions before accepting a historical price.
6. **Produce a report.** Calculate the comparison from the verified observations and explain what the evidence can and cannot establish.

## 4. Research sources and starting conditions

The experiment begins with a directory of candidate deal and price-comparison services in each market. Examples include Slickdeals and DealNews in the United States; ChoiceCheapies and PriceSpy in New Zealand; OzBargain in Australia; Hinnavaatlus and Hind in Estonia; and mydealz, idealo and Geizhals in Germany.

These are starting points, not an exhaustive list or a ranking by popularity. Their availability and suitability for historical research must be established during the experiment. Where permitted historical data is accessible, the application may use it. Otherwise, the AI must investigate other publicly accessible evidence.

The initial database will contain source information, not pre-collected product pricing histories. Validated observations may be retained and reused as the application is used. The objective is to assess whether AI can reconstruct meaningful pricing history retrospectively, rather than merely reproduce a price tracker with an existing proprietary dataset.

## 5. Consumer-facing report

Each investigation should provide, where supported by evidence:

- The exact product and current offer under assessment.
- The previous Black Friday price and the lowest observed price between the two Black Friday events, reported separately.
- A dated timeline of comparable historical offers, with supporting sources and no invented intermediate prices.
- The price difference from the historical minimum and any independently verified cheaper current alternatives.
- Evidence of promotion expiry or recurring discounts, if available.
- A concise conclusion and a description of the available evidence and its limitations.

| Conclusion | Meaning |
|---|---|
| Cheaper before | A comparable historical offer was lower. |
| Price matched before | The current price was previously available, and no lower comparable offer was found. |
| Lowest observed price | The current price is below all comparable historical observations, with adequate evidence coverage. |
| Limited history | The current offer beats a small amount of historical evidence; broader history is unknown. |
| Insufficient evidence | No reliable comparison can be made. |

A single verified lower historical price can establish that a deal has been beaten before. Conversely, a failure to find a lower price cannot prove that the product has never been cheaper. An advertised expiry is not a guarantee about future pricing.

## 6. Experimental success criteria

The targets below are defined before implementation. They are hypotheses to test, not claims about the finished product.

| Measure | Target |
|---|---:|
| Human involvement | At most 60 minutes |
| Supported shopping markets | 5 |
| Independent benchmark products | 20 |
| Correct product identification | At least 95% |
| Verified price-observation accuracy | At least 95% |
| Products with historical evidence | At least 60% |
| Products with three or more historical observations | At least 40% |
| Fabricated observations | 0 |
| Cross-market pricing errors | 0 |
| Median investigation duration | At most 60 seconds |
| Mean research cost | At most NZ$0.25 per investigation |
| Publicly usable application | Required |

The benchmark will span the five markets and multiple product categories. Inconclusive investigations and failed attempts will remain in the results, rather than being excluded to improve the reported metrics.

## 7. Experiment boundaries and reporting

The 60-minute human budget includes ideation, requirements, prompting, manual setup, supervision, debugging, validation and publication work. Machine execution time, model usage and external costs are tracked independently. The initial source directory is declared pre-work; no product-level feasibility tests or historical pricing dataset will be prepared before the experiment.

The published outcome will describe what was actually implemented, measured performance, costs, architectural compromises and remaining limitations. If reliable historical evidence is unavailable, that is a meaningful experimental result rather than a reason to invent data.

DealCheck is a consumer research tool, not a guarantee of the lowest possible price, product availability or future discounts. Continuous monitoring, checkout, paid subscriptions and retailer integrations are outside the pilot scope.

**Human intent. Machine execution.**
