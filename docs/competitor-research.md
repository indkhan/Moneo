# Moneo competitor research

Reviewed 4 October 2026. Scope: eight relevant personal-finance products, their public feature documentation, and published product UI images. No authenticated product access; screenshots are vendor illustrations, not proof of current account behavior. This is a major-feature inventory, not an exhaustive audit of every tier, region, or release. UI observations and Moneo priorities are our judgments. No pricing comparison because tiers and offers vary.

| Competitor / primary source | Major documented capabilities | UI observation from published images | Best ideas for Moneo |
|---|---|---|---|
| [Monarch](https://www.monarch.com/) | Aggregated accounts and net worth; transaction search and review; recurring detection; configurable reports; savings goals; household/advisor collaboration; web/mobile sync. [Budgeting](https://www.monarch.com/features/budgeting) documents category and flex approaches. | Separated account rows, prominent balances, whitespace, and recognizable account markers. | Customizable overview, review inbox, flexible spending groups, goal progress. |
| [Copilot](https://www.copilot.money/) | Learned categorization, transaction review, spending pace, budget rollover, cash-flow summaries, subscriptions, investment performance/allocation, property tracking. | Dark blue desktop dashboard; dense but organized cards; colored category pills; spending line compared with a reference; review action beside records. | Spending pace and one-click review, clear categories, portfolio mix. |
| [YNAB](https://www.ynab.com/features) | Bank import, device sync, shared subscriptions, category templates, custom views, widgets, targets, loan payoff calculator, spending/net-worth reports. [Method](https://www.ynab.com/the-four-rules) explains assigning available money to priorities. | Category-first budgeting with account navigation and assigned/activity/available columns; progress tied to named priorities. | Available-money clarity, rollover envelopes, target dates, debt what-if calculations. |
| [PocketSmith](https://www.pocketsmith.com/features/) | Global bank feeds, multi-currency, transaction labels/notes/search, long-range forecasts and scenarios, flexible-period budgets and calendar, dashboards, income/expense/net-worth/cash-flow reports, document management, source-linked AI integration and access controls, collaboration, scheduled summaries. | Strong category color and calendar/report views; explicit remaining-budget feedback. | Forecast/calendar connection, visible assumptions, source links, document attachment, currency context. |
| [Lunch Money](https://lunchmoney.app/features) | Bank/CSV/API/manual imports, multi-currency, crypto tracking, splits/groups/tags/categories, rules engine, recurring expenses, budgets, calendar, analytics queries, trends/net worth, collaboration, 2FA. | Desktop dashboard with aligned amounts, compact category bars, account summary, and practical review checklist. | Fast searchable transaction table, event tags, rules, review status, original currency. |
| [Rocket Money](https://www.rocketmoney.com/) | Linked accounts, subscription discovery/cancellation assistance, spending breakdown/alerts, savings automation, human bill negotiation, budgeting, net worth and credit tools. | Merchant-first rows and short actionable alerts: recognizable service, amount, change. | Renewal and price-change alerts, annualized subscription cost. Cancellation, negotiation, transfers and credit services remain outside Moneo's present scope. |
| [Quicken Simplifi](https://www.quicken.com/products/simplifi/) | Spending plan after bills/subscriptions/goals, per-day remaining allowance, savings goals, reports/filters, investments, projected cash flow/what-if scenarios, retirement planning, bill/paycheck reminders, sharing. | Category breakdown paired with date-range filters; clear expense total; recurring reminders paired with projected balances. | Available-to-spend breakdown, daily allowance, savings reservations and projected cash balances. |
| [Empower](https://www.empower.com/tools) | Linked account dashboard, portfolio/risk analysis, retirement scenarios, budgets/cash flow, net worth, transaction categorization, savings planner, debt paydown and emergency fund; professional advice and tax-provider connections. | Wealth-focused hierarchy: assets and liabilities around a central net-worth view, investment allocation and retirement charts. | Assets minus liabilities, allocation, debt and emergency-fund context. Advice/tax-provider services require separate product decisions. |

## Concept direction

Build `public/competitor-features.html` as a responsive static concept with synthetic EUR data, working local interactions, and six views: Home, Money, Plan, AI, Competitor research, Feature library. Keep source evidence beside the research and feature attribution. Preserve Moneo's existing four product areas.

Prioritize daily clarity (spending pace, available-to-spend, bills), trustworthy records (review, sources, undo), then decisions (goals, forecasts, wealth). Show collaboration, connectivity and provider-dependent features as later candidates. AI tool creation, versioning, exports and source-aware reasoning come from Moneo's own plan; competitor research does not establish exclusivity.

Prototype controls demonstrate review/undo, filtering, alternate budget modes, hypothetical savings, evidence inspection, and widget visibility. They do not connect banks, send prompts to a model, move money, cancel subscriptions, or persist financial records. Refresh resets the sample state.

## Image provenance

Images in `public/competitor-ui/` are unmodified vendor-published product illustrations retained for this internal comparison. Ownership remains with the respective vendors. The research view links to the source and identifies the illustrations; do not use these as Moneo product screenshots.

- Monarch: https://cdn.sanity.io/images/mdewiujj/production/99dbd52607deac3978603f7ed95e777f425bd5b0-1284x1202.png?auto=format&fit=max&q=90&w=642
- Copilot: https://framerusercontent.com/images/bnh1jc4bUXLlA25zPSSCyBHvc.png
- YNAB: https://cdn.prod.website-files.com/640f69143ec11b21d42015c6/6754d6950a834d8433241515_e3ea8d230f1a9f58459f2ce511ddd14b_app_devices_lineup_blurple%20%282%29.avif
- PocketSmith: https://www.pocketsmith.com/assets/images/features/features-overview-budgets-planning.png
- Lunch Money: https://lunchmoney.app/assets/images/screenshots/laptop2.png
- Rocket Money: https://framerusercontent.com/images/D1so8TjhLlV5L0jDBbRLkEl9Tok.png
- Simplifi: https://images.ctfassets.net/hfxittkcm76w/5b59UUISf7829IXW3hUNCt/997f101564e4ecdb6200e49e33694c94/image-reports-viewport-desktop-2x.webp
- Empower: https://www.empower.com/sites/default/files/styles/x_large_hq/public/image/2025-05/Fixed-aspect-ratio-spacer_0.png?itok=tp5fx619

To open: run `npm run dev`, then visit `/competitor-features.html`, or open the HTML file directly with its adjacent `competitor-ui` folder. Browser check: `npm run test:e2e -- e2e/competitor-features.spec.ts --workers=1`.
