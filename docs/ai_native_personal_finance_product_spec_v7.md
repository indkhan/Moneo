# AI-Native Personal Finance Workspace — Product Specification

**Status:** Reviewed product direction; staged delivery baseline (2026-09-16)  
**Product stage:** Clean-slate concept / pre-design  
**Primary audience:** Power users first  
**Current scope:** SaaS destination; core-loop release first, broader product staged  
**Primary platform:** Desktop web first

**Document authority (2026-09-16):** This document owns product behavior and release scope. The [technical architecture](personal_finance_technical_architecture_v11.md) owns technical contracts. No implementation backlog exists yet; epochs and stories will be written after this review. The release table below takes precedence over older uses of “V1”, “MVP”, and “locked V1” in the detailed feature catalogue. Those descriptions preserve the target product, not a requirement to ship everything together.

## Delivery baseline

The destination is a commercial SaaS built by the founder and implementation agents coordinated through an orchestrator. Deliver bounded stories, then independent adversarial review, tests, integration checks, and merge. Agent throughput does not remove the need to validate demand or reduce simultaneous moving parts.

**Product hypothesis:** A power user will repeatedly import financial data and return because grounded analysis can become an editable, persistent, live financial tool. This is worth testing; these plans do not establish market demand or willingness to pay.

| Capability | R1: core-loop release | R2: finance breadth | R3: advanced workspace |
|---|---|---|---|
| Ingestion | CSV/XLSX, manual mapping, AI mapping assistance, multiple accounts, source history, duplicate review, manual transactions/balances | Additional tested institution profiles and holdings import | Live banking remains a separate later project |
| Financial correctness | Exact money, supported fiat FX, transfer/refund treatment, categories/tags, corrections, audit/undo, coverage labels | Full event-management and richer reconciliation UX | No reduction in correctness at any stage |
| Money UI | Accounts, transaction table/filter/bulk edits, source/detail drawer, review queue, basic recurring confirmation | Saved views, rich merchant/event pages, recurring calendar, investments/assets/debt | Advanced analytics as validated |
| AI | Persistent contextual chat, evidence, activity, Stop, bounded thorough initial Deep Analysis, a few evidence-backed findings | Richer specialist investigations and proactive recommendations | Scheduled reviews and refresh |
| Planning | Basic savings goals, virtual allocations, explicit assumptions, daily cash projection, flat what-if scenarios | Spending plans, conflicts, scenario branches, richer goal types | Calibrated probabilistic forecasts only after evaluation |
| Artifacts | Editable HTML/CSS/JS, isolated runtime, live scoped Finance SDK, persisted local state, AI edits, code editor, immutable versions/revert, compact/full views | More approved primitives, export formats, richer debugging | Scheduled AI refresh |
| Home | One dashboard, trusted metrics, pin/unpin/reorder/limited grid sizes, initial personalization that respects user edits | Multiple dashboards and richer customization | Advanced automation |
| AI settings | Included AI, visible read-only prompts, usage/cost visibility, account-level AI exclusions | Custom provider keys/models/prompts and asset-level exclusions when those objects exist | Additional provider integrations after qualification |
| Shared UI | Basic navigation palette, job progress/completion, in-app notices, evidence links | Cross-object natural-language search and richer notification preferences | Scheduled summaries |
| Privacy/operations | Strong auth, tenant isolation, export/delete, backups with restore proof, retention, cost limits, redacted telemetry, security checks before external financial data | Extend controls alongside each new capability | Public launch requires applicable privacy/legal/operational review |

R1 remains a real SaaS slice, initially validated with controlled users. It is not the full-product catalogue in §70. Deferred features must not acquire placeholder tables, empty navigation pages, generic frameworks, or paid services just to anticipate later work.

**R1 artifact commitment:** Editable code is essential. This means the supported Artifact SDK and sanitized HTML/CSS subset, not unrestricted browser JavaScript, arbitrary React/npm applications, or direct DOM/network access. Clearly explain this in the editor. Embedded “Ask AI” uses the normal persistent AI panel with artifact context; it is not a second autonomous agent. Core finance totals and forecasts come from backend tools; local sliders may calculate illustrative values but cannot publish them as authoritative financial metrics.

**R1 projection commitment:** Show explicit Expected / Conservative / Optimistic assumption cases. These are scenario ranges, not P10/P50/P90 probabilities. Show horizon, dated starting balances, assumptions, missing coverage and sensitivity. “Available to Spend” is an estimate under the conservative case, unavailable when required inputs are missing or constraints cannot be met; never a guarantee or “90% safe” claim. Architecture §258 defines the calculation and per-account checks.

**R1 deep-analysis commitment:** Thoroughness means checking all available core data and explaining unsupported areas, not launching a fixed number of agents. One checkpointed investigation can cover spending, income, recurring costs, cash projection and goals; additional specialists must improve measured quality. Trigger once after the initial import batch is accepted; coalesce nearby imports, preserve review/coverage warnings, and avoid restarting expensive analysis for each file or minor correction. Home renders trusted data before AI finishes. Ordinary data refresh never requires a new model call.

**Validation before expanding:** Run the complete import → correction → grounded answer → generated artifact → pin → second import → live update journey with representative users. Record import failures/manual repair, incorrect or unsupported claims, artifact repair effort, time to useful output, AI cost, and whether users reopen saved tools. Keep testing cohorts and success thresholds explicit in the future release stories; do not substitute a generated demo for usage evidence.

**Deployment constraints resolved:** Funding is available; no fixed monthly ceiling is imposed for this planning pass. AI may process internationally. Development may use OpenRouter free models even where training is permitted, with synthetic fixtures by default and explicit opt-in for the founder's real data. Production customer traffic follows the separate no-training/ZDR policy in architecture §130. No free-model availability, operating-price or launch-date guarantee is implied.

---

# 1. Product Vision

The product is an **AI-native personal finance workspace**.

It is not intended to be just another budgeting app and it is not simply “Finanzguru + chat.”

The central idea is:

> **The user's financial data is the source of truth, AI is the intelligence layer, chat is one interface into that intelligence, and useful AI-generated outputs can become permanent live parts of the user's financial workspace.**

The product should let a user:

- Import or connect financial accounts and transactions.
- Understand their complete financial picture.
- Explore transactions in depth.
- Ask natural-language questions about their finances.
- Run deep financial analysis.
- Receive proactive insights and recommendations.
- Build goals and scenarios.
- Forecast future finances.
- Generate rich, interactive HTML/JS artifacts from their real financial data.
- Pin those artifacts to customizable dashboards.
- Edit those artifacts with AI or directly in code.
- Keep artifacts live so that they update as new financial data arrives.
- Inspect what AI is doing and what data it accessed.
- Correct the system once and have that correction propagate throughout the financial model.

For now, the product is focused on:

> **Understand, analyze, explain, forecast, simulate, and organize money.**

It should **not yet execute external financial actions** such as moving money, buying investments, cancelling subscriptions, or making payments.

---

# 2. Core Product Philosophy

## 2.1 Power-user first

The first version is intentionally optimized for users who want:

- depth,
- control,
- AI,
- powerful transaction tooling,
- customizable dashboards,
- inspectability,
- developer-like flexibility,
- and advanced financial analysis.

The surface should still feel polished and understandable, but the product does not need to be artificially simplified to the point of losing power.

---

## 2.2 Observable, not permission-heavy

The AI should be allowed to work without constantly interrupting the user with approval dialogs.

When AI performs a read-heavy or analytical task, the UI should show what it is doing in real time.

Example:

```text
Analyzing your Japan plan...

✓ Reading account balances
✓ Reading recurring payments
✓ Checking income history
● Comparing 12 months of spending
○ Running cash-flow forecast
○ Building scenario
○ Creating artifact

[ Stop ]
```

The user does **not** need to approve every read.

Instead:

- AI activity is visible.
- Data access is visible.
- The user can stop the run at any time.
- Finished runs retain an activity history.
- Destructive/external financial actions are out of scope for now.

The system should feel transparent without being annoying.

---

## 2.3 Evidence-first finance

Every important metric or AI claim should be explainable.

If the system says:

> Food spending increased 27%.

The user should be able to inspect:

```text
Jun–Aug average    €231/month
September          €293
Difference         +€62 (+26.8%)

Main contributors:
Restaurants        +€41
Delivery           +€17
Groceries           +€4
```

The user should be able to drill from a high-level claim all the way down to the supporting transactions where appropriate.

This should apply across:

- dashboard metrics,
- recommendations,
- deep analysis,
- forecasting,
- scenarios,
- artifacts,
- and chat answers.

---

## 2.4 One correction should propagate everywhere

When the user corrects the system, the correction should update the canonical financial model rather than only changing one chat conversation.

Example:

> “That €600 payment is money I send my family every month. Treat it as a recurring commitment.”

The assistant may use tools equivalent to:

```text
updateTransactionClassification(...)
createRecurringCommitment(...)
updateFinancialRule(...)
recalculateForecast(...)
invalidateAffectedInsights(...)
```

That correction should then affect:

- transaction categorization,
- recurring payment detection,
- forecasts,
- available-to-spend calculations,
- future recommendations,
- deep analysis,
- financial memory,
- goals,
- scenarios,
- and relevant artifacts.

---

# 3. Main Navigation

The primary application navigation should stay compact:

```text
Home
Money
Plan
AI
```

This is preferred over a large traditional navigation containing separate top-level tabs for every feature.

Artifacts should **not** be a separate primary navigation item.

Artifacts instead appear through:

- AI conversations,
- dashboards,
- AI → Library,
- global search / command palette,
- relevant goals/scenarios.

---

# 4. Persistent AI Interface

AI should not be hidden only inside a dedicated chat page.

A persistent AI side panel should be available from anywhere in the application.

Examples:

While viewing a transaction:

> “What is this charge?”

While viewing a chart:

> “Why did this spike?”

While viewing a goal:

> “What happens if I spend €500 next month?”

While viewing a scenario:

> “Make this more conservative.”

The panel should automatically attach the current screen/object as context.

Example:

```text
Context: Japan Planner
```

The user can remove the context if they do not want it included.

Conversations remain persistent **threads** rather than creating hidden mini-conversations for every page.

A dedicated AI area still exists for longer conversations, analysis sessions, and the AI library.

---

# 5. First-Use Experience

The first session should get the user from:

```text
zero
→ imported data
→ understood finances
→ deep analysis
→ personalized dashboard
```

as quickly as possible.

The product should avoid a long traditional onboarding questionnaire.

## 5.1 Initial flow

```text
Create account
      ↓
Import financial data
      ↓
AI understands + normalizes it
      ↓
Uncertainty handled non-blockingly
      ↓
Full deep financial analysis begins
      ↓
User can continue using the app
      ↓
Personalized dashboard is generated
      ↓
Deep analysis result becomes available
      ↓
Key findings + recommendations + artifacts
```

---

## 5.2 Deep analysis runs immediately

The first import should trigger a **real, thorough deep analysis**, not a lightweight preview.

While analysis runs, the user sees progress such as:

```text
Analyzing your finances...

✓ 2,438 transactions normalized
✓ Transfers identified
✓ Merchants cleaned up
✓ Recurring payments detected
✓ Income patterns identified
● Analyzing spending behavior
○ Building cash-flow model
○ Looking for unusual patterns
○ Identifying goals/opportunities
○ Generating your dashboard
○ Preparing your financial report

You can continue exploring — we’ll notify you when your analysis is ready.
```

The analysis must run as a persistent server-side job.

If the user closes the app, the job continues and its result is available when they return.

---

## 5.3 Personalized initial dashboard

The dashboard should be generated based on the user's actual finances.

There is a trusted default widget library, but AI decides what deserves prominence.

Someone with substantial investments might get:

- net worth,
- portfolio,
- savings,
- cash flow.

Someone with mostly transaction data might get:

- available cash,
- spending,
- recurring payments,
- cash flow,
- upcoming expenses.

As goals emerge, relevant goal widgets can be promoted.

---

## 5.4 Missing information is collected conversationally

Transactions cannot reveal everything.

Examples:

- Cash not represented in accounts.
- Debt.
- Whether investments are spendable.
- Minimum safety balance.
- Important goals.

Instead of a long onboarding form, AI can say:

> “I can improve these numbers with three pieces of information.”

and ask conversationally after the first dashboard is available.

---

# 6. Import and Account Ingestion

## 6.1 AI-first import

Import should be AI-first.

The user can upload files such as:

```text
Commerzbank.csv
Revolut.csv
Scalable.xlsx
```

The system should automatically infer:

- institution,
- account,
- date columns,
- transaction amount,
- currency,
- merchant/description,
- balance if present,
- debit/credit format,
- metadata.

The system presents a confirmation preview when useful.

A manual column mapper should still exist as a fallback.

---

## 6.2 Duplicate detection

Imports must intelligently handle overlapping periods.

Example:

- August CSV uploaded today.
- August–September CSV uploaded next month.

The system should detect duplicates and only import genuinely new transactions.

File identity alone is insufficient. Preserve legitimate identical purchases and all source observations. Where statement data cannot distinguish an overlap from a new purchase, show the unresolved rows and let the user link to an existing transaction or keep them distinct. Until resolved, exclude staged candidates from accepted totals and label the import/data coverage incomplete. The summary distinguishes new, matched, pending-review and rejected rows. Reimport and resolution retries must not duplicate effects or erase prior user corrections.

---

## 6.3 Transfer detection

Transfers between the user's own accounts should not appear as both:

- spending,
- and income.

The ingestion pipeline should attempt to match transfers between accounts.

---

## 6.4 Suggested ingestion pipeline

```text
Import
  ↓
Parse
  ↓
Normalize
  ↓
Detect account
  ↓
Detect duplicates
  ↓
Identify internal transfers
  ↓
Normalize merchants
  ↓
Categorize
  ↓
Detect recurring patterns
  ↓
Detect uncertainty
  ↓
Update financial model
```

---

# 7. Raw vs Normalized Financial Data

Original financial observations must never be silently overwritten. Explicit user deletion and the documented retention policy still apply; original uploaded bytes and parsed observations have separate lifecycles.

Every imported transaction should have at least two conceptual layers.

## 7.1 Raw transaction

Stored exactly as supplied by the bank/source.

Never silently modified.

## 7.2 Normalized transaction

The application may enrich this with:

- normalized merchant,
- category,
- subcategory,
- tags,
- recurring classification,
- transfer relationships,
- refund relationships,
- notes,
- AI confidence,
- user corrections,
- event links,
- other derived metadata.

Example:

```text
RAW:
LIDL SAGT DANKE 4817

NORMALIZED:
Merchant: Lidl
Category: Groceries
Tags: Food
Recurring: No
Transfer: No
```

The user should always be able to select:

> View original

---

# 8. Import History

Every account should preserve import history.

Example:

```text
Imports

Sep 11
Revolut_Aug-Sep.csv
842 rows
91 new
751 matched existing (source observations preserved)

Aug 03
Revolut_July-Aug.csv
792 rows
```

Opening an import should show:

- new transactions,
- duplicates,
- errors,
- uncertain rows,
- transfers detected,
- classifications made.

The user should be able to undo an entire import where technically safe.

---

# 9. Transaction System

Transactions are a **major product surface**, not merely hidden data for AI.

The transactions view should support:

- powerful search,
- filters,
- sorting,
- account filtering,
- category filtering,
- tag filtering,
- merchant filtering,
- date ranges,
- amount ranges,
- recurring status,
- transfer status,
- income/expense status,
- bulk edits,
- notes,
- merchant normalization,
- custom categories,
- tags,
- uncertainty review,
- links to original imported records.

Natural-language filtering should also exist.

Examples:

> “food last 3 months > €20”

> “Show all restaurant purchases over €20 from the last three months.”

> “Show transactions from my Paris trip.”

---

# 10. Transaction Data Model

A normalized transaction may include:

```text
Original description
Normalized merchant
Amount
Original currency
Base-currency amount
Exchange rate / source
Date
Account
Category
Subcategory
Tags
Notes
Recurring?
Transfer?
Refund?
Income?
Linked transaction
Attachments/receipt reference (later)
AI confidence
Original raw data reference
Financial event reference
```

Transaction splitting into multiple categories is **not required for the first version** and is planned for later.

---

# 11. Merchant Normalization and Categorization

The system should support both automatic and manual correction.

For examples such as:

```text
AMZN Mktp DE
Amazon EU
Amazon.de*29F7
```

the system may normalize these to:

> Amazon

Recommended behavior:

- **High confidence:** automatic.
- **Medium confidence:** suggest / surface for review.
- **Low confidence:** leave unresolved.

Every transformation should remain reversible.

---

# 12. Categories and Tags

The product should use both:

## 12.1 Internal stable taxonomy

This preserves consistent analytics.

## 12.2 User-visible custom categories

Users can customize how finances are organized.

Example:

```text
Food
  Groceries
  Restaurant
  Delivery
  Mensa
```

## 12.3 Independent tags

Tags are separate from categories.

Example:

```text
Category:
Restaurants

Tags:
Paris 2026
Vacation
With friends
```

This allows cross-category grouping.

AI can suggest semantic tags/groups such as:

> “I detected a cluster of spending in Paris from Aug 27–29. Create a `Paris 2026` group?”

AI should generally **suggest** creation of semantic groups rather than silently creating large amounts of tags.

---

# 13. Financial Events

The system should support the concept of **Financial Events**.

Examples:

- Paris trip.
- Moving apartment.
- Christmas.
- University semester.
- Japan vacation.
- New job.

Example:

```text
Paris 2026
Aug 27 → Aug 29

€387 total spending

Transport     €104
Food           €93
Hotel         €126
Shopping       €64

24 linked transactions
```

Events help the AI understand context.

This lets the system distinguish:

> “August spending rose because of a trip.”

from:

> “Your normal lifestyle spending is increasing.”

AI may detect likely events and ask to group relevant transactions.

---

# 14. Multi-Currency

Proper multi-currency support should exist from V1.

Transactions retain their native currency:

```text
¥4,200 JPY
```

Analytics also use a converted value in the user's base currency:

```text
€24.31 EUR
Exchange rate: X
Rate date: transaction date
```

The user chooses a base currency.

The dashboard generally presents totals in base currency while preserving original values at transaction level.

Conversions expose rate source/date and use the historical-rate policy defined in architecture §535. Missing conversion data must be visible: show an explicitly partial subtotal or unavailable result rather than silently treating a foreign amount as zero. Changing base currency rebuilds converted views without changing native transactions.

---

# 15. Manual Accounts and Cash

Manual financial accounts should be supported.

Examples:

- Cash Wallet.
- Manually tracked account.
- Manually tracked asset/debt.

Users can add manual transactions.

Example:

> “I spent €15 cash at the flea market.”

AI may create the manual transaction through application tools when the user explicitly requests it, with audit and undo. Unknown amount, currency or account must be clarified rather than guessed.

Manual tracking exists from V1 but should not dominate the primary UX.

A transaction-only import may not include a trustworthy account balance. Offer statement-balance capture where available and manual balance entry with an as-of date otherwise. Show balance provenance/freshness and reconciliation state. Unknown balances are not zero or the sum of imported transactions; required missing/unreconciled balances prevent an actionable Available-to-Spend result. Manual entries must clearly distinguish transactions already included in a recorded balance from later transactions so balances are not changed twice.

---

# 16. Financial Inbox / Review Queue

Classification uncertainty should be non-blocking. Ambiguous amounts, currencies, account identity or duplicate identity remain staged outside accepted totals until resolved; visible completeness warnings follow the affected metrics.

The product should not stop onboarding because 100 transactions are uncertain.

Instead, uncertain or notable items go into a dedicated review queue.

Possible items:

```text
Unknown merchant
Possible duplicate
New recurring payment
Category uncertain
Unusual charge
Large transaction
Possible transfer
Subscription price changed
```

Example:

```text
Financial Inbox                         6

Possible new subscription
Adobe · €19.99
[Confirm] [Not recurring]

Unusual transaction
Amazon · €284
[Looks right] [Investigate]

Category uncertain
PAYPAL *XYZ · €34
[Shopping] [Food] [Other]
```

AI can help process the inbox conversationally.

Example:

> “Clear my financial inbox.”

---

# 17. Audit History and Undo

Every meaningful change should have a visible history.

Example:

```text
Sep 11 15:42

AI changed:
PAYPAL *SPOTIFY

Merchant:
PayPal → Spotify

Category:
Unknown → Entertainment

Reason:
Matched recurring Spotify payment

[Undo]
```

History should cover:

- AI changes,
- user changes,
- categorizations,
- merchant normalization,
- recurring rules,
- financial rules,
- goals,
- artifacts,
- model assumptions,
- imports where applicable.

Undo should be pervasive.

---

# 18. Financial Memory

The AI should have persistent **financial memory**, not just chat history. Memory is a view over canonical goals, rules, assumptions, recurring series and AI preferences, not a second financial-facts database.

The system may learn or store information such as:

```text
Usual salary: ~€1,100
Salary normally arrives near end of month
Rent: €X
Typical grocery spend: €Y
Emergency cash target: €Z
Investments should not be treated as spendable
Japan trip planned for 2027
User prefers conservative affordability estimates
```

This memory can come from:

- transactions,
- financial model inference,
- user statements,
- explicit user rules.

Financial memory must be:

- visible,
- editable,
- inspectable.

The application should expose something like:

> **What Finance AI knows about you**

---

# 19. Financial Rules

Financial rules are first-class objects.

Examples:

> “Always keep at least €500 in Commerzbank.”

> “Don't count my ETF as money available for spending.”

> “My salary sometimes arrives between the 26th and 30th.”

The salary timing example is a financial assumption, not a deterministic rule; store it in Financial Model under income assumptions.

> “Treat anything I transfer to Scalable as savings, not spending.”

These rules affect:

- forecasting,
- available-to-spend,
- scenarios,
- recommendations,
- goals,
- deep analysis.

The user should be able to inspect and edit them under something like:

> Settings → Financial Rules

AI can also create/update them through conversation.

---

# 20. Financial Model

The product should expose the system's current understanding of the user's finances.

Likely location:

> Plan → Financial Model

Example:

```text
Expected salary       €1,120 / month
Expected rent           €390
Normal food spending    €240–€290
Safety reserve          €500
Investments spendable   No
Japan goal              €3,500 by Jul 2027
```

This page provides power users with direct control over the assumptions that drive the system.

---

# 21. Recurring Payments and Income

Recurring financial patterns should be first-class.

Examples:

```text
Spotify     €10.99 monthly
Gym         €20 monthly
Netflix     €13.99 monthly
Vattenfall  variable monthly
Rent        €390 monthly
Salary      ~€1,100 monthly
```

Users can inspect and correct detected recurring patterns.

This feeds the forecasting engine and makes metrics such as:

> “How much can I actually spend today?”

much more meaningful.

---

# 22. Forecasting Engine

Forecasting must be a fundamental deterministic system, not something each generated artifact invents independently.

Conceptually:

```text
Today
│
├─ predicted salary
├─ predicted rent
├─ recurring bills
├─ normal variable spending range
├─ goal contributions
├─ known future expenses
└─ financial rules
          ↓
Projected account balances
```

The engine should support uncertainty ranges.

Example:

```text
Expected variable spending: €820/month
Likely range: €690–€970
```

The AI then uses tools to request forecasts rather than doing arithmetic itself.

Example:

```text
project finances through August 2027 under scenario X
```

---

# 23. Explainable Metrics

Major generated metrics should be conversationally inspectable.

Example:

```text
Available to spend: €643
```

The user asks:

> “Why €643?”

The application can explain:

```text
Current cash              €1,420
- expected rent             €390
- upcoming subscriptions     €67
- normal groceries          €180
- safety buffer             €140
────────────────────────────────
Illustrative margin         €643
```

This is an illustrative breakdown. The live result uses the minimum dated margin and per-account checks in architecture §258, not necessarily a period-end subtraction.

Then the user might say:

> “Use an €80 safety buffer instead.”

This updates the financial model/rules and recalculates dependent outputs.

---

# 24. Goals

Goals should be first-class application objects, not just dashboard cards.

Examples:

```text
Japan — €3,500 by July 2027
Emergency fund — €5,000
New laptop — €1,200
```

A goal can include:

```text
Target amount
Target date
Current allocation
Priority
Linked accounts
Rules/preferences
Related scenarios
Related artifacts
```

AI should understand interactions between goals.

Example:

> “Can I buy the laptop next month without delaying Japan?”

---

# 25. Spending Plans and Budgets

Traditional budgets should exist, but they should not be the central product experience.

Preferred approach:

> **AI-generated spending plans first, traditional budget controls second.**

Example:

User:

> “I want to save €400/month without making my life miserable.”

AI:

```text
Restaurants €170 → €120
Delivery     €85 → €40
Shopping    €190 → €130
Everything else unchanged
```

The system can monitor the plan and relate recommendations to it.

---

# 26. Scenarios

Scenario modeling is a core feature.

Examples:

- Japan trip.
- Buying a laptop.
- Salary increase.
- Rent increase.
- Moving cities.
- Erasmus semester.
- Quitting a job.
- Large purchase.

Scenarios should sit on top of the forecasting engine.

Example branches:

```text
Actual
├─ Japan
├─ Japan + reduced eating out
└─ Japan + €500 higher monthly income
```

Scenario artifacts can provide interactive controls and simulations.

---

# 27. Proactive Recommendation Engine

The AI should not wait for the user to ask everything.

It should proactively surface a small number of high-value findings.

Recommended behavior:

- highly proactive,
- selective,
- rank insights,
- avoid generic noise.

Examples:

- unusual spending,
- trends,
- subscriptions becoming more expensive,
- duplicate charges,
- income changes,
- unusually large purchases,
- upcoming cashflow problems,
- idle cash,
- goals falling behind,
- category overspending,
- new recurring payments,
- investment allocation changes,
- potential savings opportunities.

Dashboard example:

```text
Things worth your attention

↑ Food spending is €74 higher than normal
  [Why?] [Track it]

⚠ €460 of recurring payments in the next 10 days
  [View]

✈ Japan goal is currently 3 weeks behind target
  [Adjust plan]
```

---

# 28. Recommendations Should Be Actionable

Recommendations should combine:

- observation,
- explanation,
- next action.

Example:

> Restaurant spending increased 35%, mainly because of six additional purchases. At your normal rate you'd have about €92 more this month.

Actions:

```text
[Show me why]
[Create tracker]
[Set target]
[Ignore]
```

If the user creates a tracker, that can become a live artifact and be pinned to a dashboard.

Ignoring recommendations can help the system learn what the user does not care about.

---

# 29. Recommendation Tone

Recommendations should connect behavior to the user's own goals without being judgmental.

Avoid:

> “You spend too much on coffee.”

Prefer:

> “At your current rate, your Japan goal reaches its target in August. Reducing eating out by about €70/month would bring that to June.”

The system may be opinionated when:

- the reasoning is supported by data,
- the recommendation connects to goals/rules the user explicitly established,
- assumptions are visible.

For now, the application should avoid telling users exactly which securities or financial products to buy.

---

# 30. Notifications

Recommendations can have multiple urgency levels.

Suggested model:

- Normal insight → dashboard only.
- Important → notification.
- Potentially urgent/unusual → stronger notification.

Examples:

> “You were charged €89.99 for a subscription that normally costs €39.99.”

> “Your projected balance drops below your €500 safety buffer next week.”

Users can configure how proactive notifications are.

---

# 31. Deep Financial Analysis

Deep Analysis is one of the core differentiators.

The analysis should behave more like an investigative financial analyst than a static report generator.

It should combine:

- deterministic calculations,
- iterative AI exploration,
- anomaly investigation,
- contextual reasoning,
- forecasting,
- recommendation generation,
- artifact creation.

Example investigation:

```text
Restaurant spending looks unusual.
↓
Compare previous months.
↓
July is higher.
↓
Check locations.
↓
Most transactions occurred in France.
↓
Transportation also increased.
↓
Likely travel period.
↓
Treat as event, not permanent lifestyle change.
```

---

# 32. Saved Analysis Sessions

Deep analyses should be saved historically.

Example:

```text
Financial Reviews

September 2026
December 2026
March 2027
```

The user can later ask:

> “What has changed since my September review?”

These reviews can become a timeline of the user's financial life.

---

# 33. Analysis Types

Do not create a cluttered UI with dozens of analysis buttons.

Provide:

> **Deep Analysis**

as the primary experience.

Users can then request custom analysis through AI.

Examples:

- spending audit,
- subscription audit,
- cash-flow risk analysis,
- travel affordability,
- investment overview,
- savings opportunities.

---

# 34. AI Interaction Model

The AI should generally **do useful work first and ask only when missing information materially changes the answer**.

Example:

User:

> “Can I afford Japan next summer?”

Preferred behavior:

1. Inspect finances.
2. Make reasonable assumptions.
3. Clearly state assumptions.
4. Build an initial scenario.
5. Ask only for genuinely important missing information.

Instead of asking ten questions before doing anything.

---

# 35. Chat vs Artifact Decision

Simple questions should remain chat answers.

Examples:

> “How much did I spend on food last month?”

Complex tasks should automatically produce artifact previews.

Examples:

> “Analyze whether I can afford a three-week Japan trip.”

> “Give me a complete breakdown of my spending this year.”

The AI should decide when an artifact adds meaningful value.

---

# 36. Artifact Concept

An artifact is a persistent AI-generated mini-application connected to the user's financial system.

It is not merely a static HTML export.

Artifacts can be:

- reports,
- dashboards,
- scenario simulators,
- trackers,
- comparisons,
- timelines,
- table explorers,
- calendars,
- forecasts,
- goal monitors,
- or completely custom interfaces.

---

# 37. Artifact Runtime

Artifacts may contain HTML/CSS/JS but must never receive arbitrary direct access to banking credentials or unrestricted backend APIs.

Artifacts use a controlled Finance SDK / API surface.

Conceptual examples:

```js
finance.transactions.query(...)
finance.accounts.getBalances()
finance.analytics.monthlySpend(...)
finance.scenarios.project(...)
finance.goals.get(...)
```

Generated JS is sandboxed and receives scoped financial capabilities.

---

# 38. Live Artifacts

Artifacts should remain live.

Example:

A Japan planner created in September should use updated financial data when opened two months later.

Artifact flow:

```text
Artifact loads
    ↓
Requests allowed financial data from backend
    ↓
Backend evaluates permissions
    ↓
Current data returned
    ↓
Artifact recalculates
```

---

# 39. Artifact Permissions and Data Visibility

The system should be privacy-first without adding approval friction.

An artifact should declare what it can access.

Example:

```text
Japan Planner uses:

✓ account balances
✓ monthly income/spending aggregates
✓ Japan goal
✓ recurring expenses
✕ raw transaction descriptions
✕ investment transaction history
```

Users do not need to approve every normal read.

They can inspect the permissions and stop AI operations when needed.

---

# 40. Artifact Modes

Each artifact should support at least:

## Dashboard / compact mode

A concise widget suitable for a dashboard.

## Full-screen mode

The complete interactive generated application.

---

# 41. Artifact Lifecycle

Artifacts are first-class objects.

Suggested metadata:

```text
Artifact ID
Name
Description
HTML/CSS/JS
Required data permissions
Created by conversation / analysis
Created at
Last modified
Dashboard configuration
Artifact state
Version history
Activity history
```

---

# 42. Artifact State

Artifacts can store their own persistent state.

Example:

```text
Trip length      21 days
Flights          €850
Hotel/night      €52
Daily spending   €65
Scenario         Conservative
```

This state persists when the user returns.

Important separation:

> **Artifact-local state does not automatically change the canonical financial model.**

If an artifact wants to apply something globally, it should expose an explicit action.

Example:

> Save these assumptions to Japan goal.

---

# 43. Embedded AI in Artifacts

Artifacts should have an embedded AI entry point.

Example:

```text
Ask about this analysis...
```

User:

> “Why was March so high?”

Or:

> “Add another chart comparing weekdays and weekends.”

The artifact's context is automatically available to that AI interaction.

---

# 44. Artifact Editing

Artifacts should support conversational editing.

Examples:

> “Make this graph smaller.”

> “Add my savings account.”

> “Remove crypto.”

> “Use weekly instead of monthly.”

> “Add a pessimistic case.”

The same artifact is edited in place.

Artifacts have version history and undo.

---

# 45. Manual Artifact Code Editing

Artifacts should also be directly editable by advanced users.

Suggested artifact interface:

```text
Preview
Code
Data
Activity
Versions
```

Normal users can edit through AI.

Power users can directly edit generated HTML/CSS/JS.

---

# 46. Artifact Templates

Internally, the system may provide reliable templates/primitives such as:

```text
Report
Dashboard
Scenario simulator
Tracker
Comparison
Timeline
Table explorer
Calendar
Forecast
Goal monitor
```

The AI may use these as starting points but is not forced to.

Very high visual and structural freedom is desired.

---

# 47. Artifact Generation Pipeline

Artifacts should not simply publish the first code output from one model.

Recommended pipeline:

```text
User request
    ↓
Artifact planner
    ↓
Artifact builder/coder
    ↓
Automated checks
    ↓
Artifact reviewer
    ↓
Automatic fix pass if needed
    ↓
Render preview
```

Automated checks should cover things such as:

- only approved Finance SDK APIs,
- no arbitrary external network requests,
- no access to secrets,
- JS executes,
- no obvious runtime errors,
- responsive enough,
- handles missing data,
- handles empty states,
- expected data displayed,
- no obvious misleading calculations,
- compact dashboard mode exists,
- basic accessibility/UI quality.

---

# 48. Multiple Artifacts from One Analysis

A single complex analysis can generate multiple connected artifacts when that is genuinely helpful.

Example:

```text
Complete Financial Review
├─ Monthly Spending
├─ Subscription Analysis
└─ Cashflow Forecast
```

The system should not generate unnecessary artifacts just for the sake of quantity.

---

# 49. Scheduled Artifact AI Refresh

Artifacts may support scheduled AI-powered refresh or analysis.

Normal financial data refresh is live automatically.

Scheduled AI refresh can run additional interpretation such as:

> “Restaurant spending changed materially this week because…”

This capability should exist in the design.

---

# 50. Artifact Export

Early support:

- PDF export.
- Screenshot/image export.

Later:

- public/share links,
- sanitized snapshots,
- richer external sharing.

Public live access to personal financial backends should not be casually exposed.

---

# 51. Dashboard System

Everything on Home should conceptually be a widget.

Examples:

```text
Net Worth
Available to Spend
Cashflow
Recommendations
Goals
Upcoming Payments
Account Balance
Spending Breakdown
Pinned Artifact
```

AI-generated artifacts should sit naturally beside first-party widgets.

---

# 52. Dashboard Customization

The dashboard should be highly customizable.

Users can:

- move widgets,
- resize widgets,
- remove widgets,
- add widgets,
- pin artifacts,
- duplicate compatible widgets,
- ask AI to modify layout.

Example:

> “Make the Japan widget wider.”

---

# 53. Trusted Built-In Widgets

Built-in widgets should remain trusted application components.

AI can change their settings and layout.

Examples:

> “Show six months instead of three.”

> “Show savings instead of spending here.”

But the system should not automatically convert built-in widgets into arbitrary generated code.

---

# 54. Multiple Dashboards

Users can create multiple dashboards.

Example:

```text
Main
Monthly Review
Japan
Investments
2027 Planning
```

Artifacts can be pinned to one or more dashboards.

AI can suggest creating a dashboard.

Example:

> “This analysis has five related widgets. Want me to create a Japan dashboard?”

The default Home dashboard always exists.

---

# 55. Default Home Layout

A default personalized Home could resemble:

```text
Net Worth       Available       This Month
€12,420         €1,340          -€822

──────────────────────────────────────────

Things worth your attention

↑ Food spending is €74 higher than normal
  [Why?] [Track it]

⚠ €460 recurring payments in next 10 days
  [View]

✈ Japan goal is 3 weeks behind target
  [Adjust plan]

──────────────────────────────────────────

Cash flow
[chart]

Goals                Upcoming
Japan ██████░         Rent     Sep 30
Laptop ███░░░         Spotify  Oct 2

──────────────────────────────────────────

Pinned widgets / artifacts...
```

The recommended information hierarchy is:

1. critical financial numbers,
2. recommendations,
3. detailed dashboard content.

---

# 56. Global Search / Command Palette

The application should provide a power-user command palette/global AI search.

Likely shortcut:

```text
⌘K / Ctrl+K
```

It can search:

- transactions,
- accounts,
- merchants,
- categories,
- goals,
- artifacts,
- conversations,
- analysis sessions,
- commands.

It can also understand natural language.

Examples:

> `transactions in Paris`

> `payments over €100 last summer`

> `Spotify`

> `Japan plan`

> `that chart about food`

> `why was March expensive`

The interface can either navigate, filter, or trigger an AI answer depending on the request.

---

# 57. Intelligent Object Pages

Major financial objects should have rich detail pages even without chat.

Examples:

- account,
- merchant,
- category,
- goal,
- event.

An account page may show:

- balance,
- inflow/outflow,
- recurring payments,
- spending categories,
- recent transactions,
- AI insights specific to the account.

The user can ask:

> “What do I mostly use this account for?”

---

# 58. Money Section

Current high-level structure:

```text
Money

Overview
Transactions
Accounts
Recurring
Investments
Assets & Debt
Review
```

The exact V1 screen design will be defined separately.

---

# 59. Plan Section

Plan is expected to contain concepts such as:

- goals,
- spending plans,
- budgets,
- scenarios,
- forecasts,
- Financial Model.

Exact screen design will be defined separately.

---

# 60. AI Section

AI is expected to contain:

- persistent conversations,
- deep analysis sessions,
- saved analyses,
- artifact library,
- AI activity/history,
- potentially prompts/model settings through Settings.

Exact screen design will be defined separately.

---

# 61. AI Modes

There are only two AI modes.

## 61.1 Normal mode

The product provides the AI.

The application decides:

- models,
- routing,
- prompts,
- reviewer models,
- capability-specific configuration.

The user can inspect prompts and activity, but cannot edit prompts or choose models.

The application uses **OpenRouter** for model access/routing.

## 61.2 Custom mode

The user connects their own supported provider/API credentials.

The user can:

- choose models per capability,
- edit capability-specific prompts,
- use the application's AI tooling/runtime with their chosen models.

There are no extra Fast / Best / Automatic presets beyond the default normal mode and custom mode.

---

# 62. Capability-Specific Prompts

There is **no single giant application system prompt**.

Each AI capability has its own prompt.

Examples:

```text
Financial Assistant
Deep Analysis
Transaction Classifier
Merchant Normalizer
Recommendation Engine
Forecast Interpreter
Artifact Planner
Artifact Builder
Artifact Reviewer
Financial Inbox
```

In Normal mode:

- prompts are visible,
- prompts are read-only.

In Custom mode:

- prompts are editable,
- each prompt has **Restore default**.

No end-user prompt-testing workflow is required; product-managed prompts still require offline evaluation.

No user-facing prompt version history is required. Internal prompt/configuration versions are retained for audit, evaluation and rollback.

---

# 63. AI Model Routing

In Normal mode, the application chooses the model for each job.

Conceptually:

```text
Fast classification       → cheap/fast model
Merchant normalization    → cheap/fast model
Normal chat               → strong general model
Deep analysis reasoning   → strong reasoning model
Artifact coding           → strong coding model
Artifact review           → separate review model
```

The exact model mapping should be controlled by the product team and may change over time.

In Custom mode, users can choose compatible models for each capability.

---

# 64. AI Activity History

Completed AI runs should preserve a user-visible activity trace.

This is **not hidden chain-of-thought**.

It is an operational record of relevant actions and data access.

Example:

```text
Deep Analysis

1. Loaded financial model
2. Queried balances
3. Calculated 12-month cashflow
4. Loaded Japan goal
5. Projected finances to July 2027
6. Ran baseline scenario
7. Ran conservative scenario
8. Generated recommendation
9. Generated Japan Planner artifact
```

Also show data access where appropriate:

```text
Data accessed:
• Commerzbank: 821 transactions
• Revolut: 1,104 transactions
• Scalable: balance only

Artifacts modified:
• Japan Planner v4 → v5
```

This history remains accessible after the run completes.

---

# 65. AI Stop Behavior

During active AI work, the user should always have a visible:

> **Stop**

control.

Stopping should attempt to:

- cancel pending AI/model work,
- stop additional tool calls,
- stop further artifact generation,
- leave already committed safe read/analysis state intact.

The UI should make clear what had already completed before cancellation.

---

# 66. Privacy and Security Model

The application should be privacy/security-first.

Core rules:

- Raw transactions belong to the finance backend.
- Generated artifacts do not receive arbitrary database access.
- Bank credentials are never exposed to generated artifacts.
- AI accesses financial information through controlled tools.
- Artifacts access data through a scoped Finance SDK.
- Data access is visible through activity history.
- Users can inspect artifact permissions.
- Sensitive backend secrets are never included in generated HTML/JS.

---

# 67. Cloud Architecture

V1 is cloud-first.

Cloud is preferred because the product needs:

- persistent imports,
- background deep analysis,
- notifications,
- synced dashboards,
- live artifacts,
- server-side jobs,
- future bank sync,
- future mobile support.

A local/self-hosted edition may be considered later, especially because the initial audience includes power users.

---

# 68. Desktop First

The first serious product is desktop web.

The experience is optimized for:

- large dashboards,
- transaction tables,
- analysis,
- artifacts,
- code inspection,
- deep interaction.

A later mobile companion can focus on:

- dashboard,
- notifications,
- chat,
- transaction review,
- quick categorization,
- goals.

The full desktop workspace does not need to be squeezed into mobile immediately.

---

# 69. Accounts and Financial Types

The long-term financial model should support a complete personal picture:

```text
Cash accounts
Bank accounts
Credit cards
Investments
Crypto
Loans/debt
PayPal / wallets
Cash
Assets
Salary/income
```

The first ingestion mechanisms may support only part of this.

The internal model should avoid assuming that bank transactions are the only possible financial data type.

---

# 70. Full-Product Capability Catalogue

The target product contains the capabilities below. The Delivery baseline assigns release timing; this catalogue is not the R1 launch checklist.

## 70.1 Data ingestion

- CSV import.
- XLSX import.
- Multiple accounts.
- AI-first schema detection.
- Manual mapping fallback.
- Import previews.
- Duplicate detection.
- Transfer detection.
- Multi-currency.
- Raw + normalized transaction layers.
- Import history.
- Manual/cash accounts.

## 70.2 Transactions

- Powerful transaction table.
- Search/filtering.
- Natural-language filtering.
- Merchant normalization.
- AI categorization.
- User categories.
- Tags.
- Recurring detection.
- Review inbox.
- Audit history.
- Undo.

## 70.3 Intelligence

- Persistent AI panel.
- AI threads.
- Financial memory.
- Financial rules.
- Deep Financial Analysis.
- Saved analysis sessions.
- Evidence-backed explanations.
- Recommendation engine.
- AI activity history.
- Stop controls.

## 70.4 Planning

- Goals.
- Spending plans / budgets.
- Forecasting engine.
- Scenarios.
- Financial Model.

## 70.5 Dashboard

- Personalized initial dashboard.
- Built-in trusted widgets.
- Fully customizable layouts.
- Recommendations.
- Multiple dashboards.
- Pinning artifacts.

## 70.6 Artifacts

- HTML/CSS/JS artifacts.
- Restricted Finance SDK.
- Live financial data.
- Compact + full-screen modes.
- Persistent artifact state.
- Embedded AI.
- Conversational editing.
- Direct code editing.
- Version history.
- Activity history.
- Planner/builder/reviewer pipeline.
- Automated artifact checks.
- Multiple artifacts per analysis.
- PDF/screenshot export.
- Scheduled AI refresh capability.

## 70.7 AI configuration

- Normal mode using included AI through OpenRouter.
- Custom provider/model mode.
- Per-capability prompts.
- Prompts visible in Normal mode.
- Prompts editable only in Custom mode.
- Restore-default prompt behavior.

---

# 71. Explicitly Later / Not Required for Initial MVP

The following are deliberately not the current focus.

## Bank integrations / Open Banking

Live bank connections come later.

CSV/XLSX first allows the intelligence layer and product UX to be perfected without making bank APIs the foundation of the project.

## Mobile app

Later.

## Shared/household finances

Single user first.

Architecture can avoid making future sharing impossible, but no household UX is required now.

## Transaction splitting

Later.

## Financial documents

Later.

Possible future document types:

- payslips,
- invoices,
- rental agreements,
- tax documents,
- insurance documents,
- investment statements.

The data model should not block future document integration, but full document intelligence is not part of the current MVP.

## Public artifact sharing

PDF/screenshot export first.

Public share links/sanitized snapshots later.

## External financial actions

Not now.

Examples intentionally excluded:

- moving money,
- buying securities,
- cancelling subscriptions,
- paying bills,
- executing transfers.

## Direct product/investment recommendations

The system may analyze finances and show implications, but should not initially tell users exactly which specific financial product/security to purchase.

---

# 72. Important Product Loops

## 72.1 Main loop

```text
Import/connect money
        ↓
Understand finances
        ↓
Ask / discover
        ↓
Analyze
        ↓
Create useful artifact / tracker / goal
        ↓
Pin to dashboard
        ↓
Artifact stays live as finances change
```

## 72.2 Correction loop

```text
AI makes interpretation
        ↓
User corrects it once
        ↓
Canonical financial model updates
        ↓
Forecasts + analysis + dashboard + recommendations update
```

## 72.3 Recommendation loop

```text
System notices something meaningful
        ↓
Explains why it matters
        ↓
Offers direct action
        ↓
User creates tracker / goal / plan / artifact
        ↓
System monitors it over time
```

## 72.4 Deep-analysis loop

```text
Data
  ↓
Deterministic metrics
  ↓
AI investigates anomalies/context
  ↓
Additional finance tool queries
  ↓
Evidence-backed findings
  ↓
Forecasts / scenarios
  ↓
Recommendations
  ↓
Artifacts
  ↓
Personalized dashboard updates
```

---

# 73. Example End-to-End Experience

A user uploads:

```text
Commerzbank.csv
Revolut.csv
Scalable.xlsx
```

The system:

1. Detects the file structures.
2. Creates the accounts.
3. Normalizes transactions.
4. Links confirmed overlaps without erasing source observations; stages ambiguous rows for review.
5. Matches transfers.
6. Normalizes merchants.
7. Categorizes high-confidence transactions.
8. Adds uncertain transactions to Review.
9. Detects recurring payments.
10. Builds the initial financial model.
11. Starts a thorough Deep Financial Analysis.
12. Shows live progress and allows the user to continue using the app.
13. Builds the personalized Home dashboard.
14. Saves the completed analysis.
15. Surfaces the most important recommendations.

Later the user asks:

> “I'm planning to go to Japan next summer. Can I afford it?”

The AI:

1. Reads the financial model.
2. Reads balances.
3. Reads recurring commitments.
4. Reads relevant goals.
5. Examines income and spending history.
6. Creates reasonable assumptions.
7. Runs baseline and conservative forecasts.
8. Clearly states assumptions.
9. Answers the question.
10. Generates a Japan scenario artifact because the task is complex.
11. Runs the artifact through automated checks and review/fix passes.
12. Shows the artifact in chat.
13. Lets the user interact with sliders.
14. Lets the user save/pin it.
15. Keeps it live as new data is imported.

Later:

> “Make the Japan plan assume a €1,200 hotel budget and show me what I need to save every month.”

The existing artifact is edited rather than replaced.

The user pins the compact version to the `Japan` dashboard.

---

# 74. Current Product Identity

The current product should be thought of as:

> **A programmable personal finance operating system powered by AI.**

Its defining traits are:

- complete financial understanding,
- strong transaction tooling,
- conversational interaction,
- deep analysis,
- explainability,
- proactive recommendations,
- forecasting,
- goals/scenarios,
- programmable live artifacts,
- customizable dashboards,
- user-visible AI activity,
- power-user control.

The differentiator is not merely “AI chat over transactions.”

The differentiator is the combination of:

> **financial model + AI tools + live generated interfaces + persistent workspace**

---

# 75. Next Planning Phase

The screen catalogue in §§77–82 is already defined. Next, translate only the R1 slice into bounded epochs and stories using the resolved deployment constraints. Each story needs behavior, invariants, dependencies, error/empty/incomplete states and runnable acceptance checks. Prototype the artifact runtime early; do not wait until the end to learn whether the main differentiator is feasible.

No application implementation is authorized by the existence of a feature description alone. The future backlog will control assignments and merge order; it cannot silently expand release scope or weaken financial/security invariants.

---

# 76. Decisions That Are Already Locked

These describe the target product. The Delivery baseline controls staging; R2/R3 items below are not R1 commitments:

- Power-user first.
- Desktop web first.
- Cloud first.
- Single-user first.
- Home / Money / Plan / AI navigation.
- Persistent contextual AI side panel.
- Full Deep Analysis immediately after first import.
- Deep Analysis runs as a background server-side job.
- Personalized first dashboard generated from data.
- AI-first import with manual fallback.
- Non-blocking uncertainty / Financial Inbox.
- Complete transaction experience.
- Raw financial data preserved.
- Audit history + undo.
- Multi-currency from V1.
- Manual/cash accounts.
- Tags independent from categories.
- Financial Events.
- Financial memory visible/editable.
- Financial Rules.
- Recurring payments as first-class objects.
- Forecasting as a fundamental engine.
- Goals as first-class objects.
- AI-first spending plans with traditional budgets available.
- Scenarios.
- Proactive but selective recommendations.
- Recommendation tone tied to user goals, not judgment.
- Explainable metrics.
- Notifications.
- Persistent historical deep analyses.
- Simple questions stay in chat.
- Complex questions can automatically create artifacts.
- Artifacts are live HTML/JS mini-apps using a restricted Finance SDK.
- Artifact state persists.
- Artifact-local state stays separate from canonical financial state unless explicitly applied.
- Artifacts can contain embedded AI.
- Artifacts can be edited by AI and manually.
- Artifact version history.
- Artifact review/fix pass before presentation.
- Multiple artifacts per analysis when useful.
- Multiple dashboards.
- Artifacts live under AI → Library rather than top-level navigation.
- Included AI uses OpenRouter and product-controlled routing.
- Custom AI mode supports provider/model selection.
- Prompts are capability-specific.
- Normal mode prompts visible but read-only.
- Custom mode prompts editable.
- Restore default prompt.
- AI activity history visible.
- AI work is observable and cancellable instead of permission-heavy.
- CSV/XLSX first; live bank integrations later.
- Financial documents later.
- Transaction splitting later.
- No money-moving/external financial actions for now.
- Serious SaaS-quality product, monetization/business model not yet the focus.


---

# 77. Home Screen — Target Product Design

The Home screen is now considered defined at the product level.

## 77.1 Default top metrics

The default top metrics are:

```text
Net Worth
Available to Spend
This Month
```

These metrics are explainable and interactive rather than decorative.

Clicking a top metric should open a rich detail panel instead of immediately navigating away.

Example:

```text
Available to Spend
€1,340

How we got this
Current cash              €2,340
Upcoming fixed expenses    -€510
Expected normal spending   -€290
Safety reserve             -€200
────────────────────────────────
Illustrative margin        €1,340

Forecast
Today        €1,340
In 7 days    €1,102
In 30 days     €780

[Ask AI about this]
[Open full analysis]
```

This mockup illustrates inspectability, not the calculation formula. Live details use the limiting day/account and explicit assumptions in architecture §258.

The detail panel should support follow-up questions such as:

> “Why are you reserving €290?”

This pattern should be reused across other trusted built-in widgets where appropriate.

## 77.2 Dashboard-wide period

Home has a global time/date selector such as:

```text
September 2026
Last 30 days
This year
Custom
```

Compatible widgets use the dashboard-wide period by default, while individual widgets may override it.

## 77.3 Explicit Customize mode

Home has a clear **Customize** mode. It enables:

- drag/reorder,
- resizing,
- removing,
- duplicating,
- configuring,
- moving between dashboards,
- adding widgets,
- AI-assisted layout editing.

Normal viewing mode keeps the dashboard stable.

## 77.4 Add flow

The primary dashboard add control offers:

```text
+ Add

Widgets
Your Artifacts
Create with AI
```

**Create with AI** opens the persistent AI panel with dashboard context.

## 77.5 Multiple dashboard selection

The dashboard name appears prominently:

```text
Main Dashboard ▾
```

Possible dashboards:

```text
Main
Monthly Review
Japan
Investments
+ New Dashboard
```

A dropdown/selector is preferred over permanently visible horizontal tabs.

## 77.6 Home while first Deep Analysis is running

Home should not remain empty while initial Deep Analysis runs.

It should:

- show immediately available reliable information,
- show live Deep Analysis progress,
- gradually populate trusted widgets,
- transition into the personalized dashboard when complete.

## 77.7 Recommendation behavior on Home

Home shows the **top 3** recommendations expanded, with **See all** for the complete recommendation view.

Recommendations can be dismissed. Dismissed insights should only return when circumstances materially change.

Users can set conversational recommendation rules, e.g.:

> “Stop telling me about restaurant spending unless it goes above €300.”

## 77.8 Dashboard AI editing

AI understands the dashboard structure.

Example:

> “Make this dashboard more focused on cash flow.”

AI may propose:

```text
I’ll:
• enlarge Cash Flow
• move Upcoming Payments higher
• add a 30-day Balance Forecast
• move Spending Breakdown lower

[Apply]
```

If the user gives an explicit imperative such as **“Do it”**, the system may perform the safe dashboard change directly with Undo available.

## 77.9 Widget menus

Trusted built-in widgets may expose:

```text
Configure
Ask AI about this
Resize
Duplicate
Move to dashboard
Remove
```

Generated artifacts may expose:

```text
Open full screen
Edit with AI
Edit code
Versions
Activity
Move / Pin
Remove
```

## 77.10 Prominent Home AI input

Home includes a visible input:

> **Ask anything about your money…**

Submitting from it opens/continues the normal persistent AI thread experience.

## 77.11 Since You Last Checked

Home can show a compact **Since you last checked** summary when there is useful new information.

Example:

```text
€82 spent
2 new transactions
1 recurring charge
Japan goal unchanged
```

It should not occupy permanent space when nothing meaningful changed.

## 77.12 Home information hierarchy

The default hierarchy is:

1. Page/dashboard controls.
2. Prominent AI entry point.
3. Top financial metrics.
4. High-value recommendations.
5. Since-you-last-checked summary when useful.
6. Core trusted widgets.
7. Pinned artifacts and custom widgets.


---

# 78. Money Section — Target Product Design

The Money section is now defined as the primary structured financial-data workspace.

Primary structure:

```text
Money

Overview
Transactions
Accounts
Recurring
Investments
Assets & Debt
Review
```

The section should feel more like a powerful financial database and analysis workspace than a conventional banking app.

## 78.1 Money Overview

The Money Overview should answer:

> “What does my financial world look like right now?”

Suggested summary structure:

```text
Total assets        €14,820
Total debt           €2,400
Net worth           €12,420
Available cash       €4,100

Accounts
Commerzbank          €1,840
Revolut                €920
Cash                    €80

Investments
Scalable             €7,980

Debt
Student loan         €2,400

This month
Income               €2,140
Spending             €1,318
Net cash flow          €822
```

Below the summary, the page may include:

- cash-flow chart,
- asset allocation,
- account balances,
- spending by category,
- recurring commitments,
- recent activity,
- AI insights.

Clicking a metric/object should drill into the relevant account, category, transaction set, investment account, recurring item, asset, or debt object.

## 78.2 Transactions Page

Transactions should be one of the strongest V1 surfaces.

Suggested layout:

```text
Transactions                         [Ask AI] [+ Add]

Search or ask:
[ restaurant > €20 last 3 months... ]

Filters:
All accounts | All categories | Date | Amount | More

Date       Merchant       Account      Category       Amount
Sep 10     Lidl           Revolut      Groceries      -€31.42
Sep 09     DB             Commerzbank  Transport      -€27.90
Sep 08     Salary         Commerzbank  Income       +€1,120
```

V1 transaction capabilities should include:

- configurable columns,
- sorting,
- saved views,
- bulk selection,
- bulk category/tag edits,
- inline editing where safe,
- keyboard shortcuts,
- natural-language filtering,
- expandable detail drawer,
- import/source visibility,
- account/category/merchant/date/amount filters,
- recurring/transfer/income status filters.

## 78.3 Saved Transaction Views

Saved views are part of V1.

Examples:

```text
Large expenses
Paris 2026
Unreviewed
Subscriptions
Business expenses
```

A saved view stores the active filters/sort/visible columns and can be reopened quickly.

AI can also create saved views conversationally.

Example:

> “Save this as Large Restaurant Purchases.”

## 78.4 Transaction Detail Drawer

Clicking a transaction should usually open a side/detail drawer rather than navigating away from the table.

Example:

```text
Lidl
-€31.42

Sep 10, 18:42
Revolut

Category
Groceries

Tags
Food
Germany

Status
Normal transaction

Original description
LIDL SAGT DANKE 4817

AI understanding
Merchant confidence: 99%
Category confidence: 94%

[Ask AI about this]
```

The detail view should support:

- edit category,
- edit merchant,
- add/remove tags,
- notes,
- mark as transfer,
- mark as recurring/not recurring,
- link related transaction,
- inspect audit history,
- inspect raw imported data,
- inspect source/import.

## 78.5 Accounts

Accounts must have rich detail pages rather than being simple balance entries.

Example:

```text
Commerzbank

Balance               €1,840
Available             €1,420
Monthly inflow        €1,120
Monthly outflow         €870

[balance history]

Used mainly for
• salary
• rent
• recurring bills

Recurring from this account
...

Recent transactions
...

AI insights
...
```

Account settings should include:

- display name,
- institution,
- account type,
- currency,
- whether it is spendable,
- whether it counts toward net worth,
- import history,
- account-specific rules,
- archive/delete controls where appropriate.

## 78.6 Recurring

Recurring payments and income should have their own powerful page because they feed forecasting and available-to-spend calculations.

Suggested structure:

```text
Recurring

Upcoming
Calendar
Subscriptions
Income
All
```

Example fixed recurring item:

```text
Rent
€390 monthly
Usually 1st of month
Confidence: High
Next expected: Oct 1

[Edit] [View history]
```

Example variable recurring item:

```text
Electricity
Usually €42–€67
Monthly
Next expected: ~Oct 14
```

Subscription-specific information may include:

- current amount,
- first seen,
- next expected charge,
- yearly cost,
- historical price changes,
- linked transactions,
- confidence,
- user corrections.

## 78.7 Investments

Investments belong in the V1 information architecture.

Initial V1 scope should remain intentionally focused.

Potential support:

- manually imported investment holdings,
- investment-account CSV/XLSX,
- portfolio value,
- holdings,
- allocation,
- contribution history,
- cash vs invested,
- gains/losses when source data is sufficient,
- AI analysis.

V1 should **not** attempt to become a full brokerage/realtime trading tracker.

The main purpose is:

- complete net worth,
- accurate financial context,
- planning/scenarios,
- useful high-level portfolio understanding.

## 78.8 Assets & Debt

Assets and debt should be combined into one section initially.

Example assets:

- car,
- property,
- manually tracked valuable asset,
- cash-value asset.

Example debt:

- loan,
- credit-card balance,
- personal debt,
- money owed.

Each item should support current value/balance and historical values when available.

V1 goal:

> make net worth, forecasts, and scenarios accurate.

The app does not need to become a specialist debt-management platform in V1.

## 78.9 Review

Money → Review is the full Financial Inbox workspace.

Suggested tabs:

```text
Needs attention
Uncertain
Possible duplicates
Transfers
Recurring
Unusual
Resolved
```

Users can review items manually or select:

> **Review with AI**

The Review area is where messy financial data gets cleaned without polluting the main transaction experience.

It should support:

- batch decisions,
- AI-assisted resolution,
- confidence display,
- source evidence,
- undo,
- audit history.

## 78.10 Merchant Detail Pages

Merchant pages are part of V1.

Example:

```text
Lidl

Total spent this year    €842
Visits                    31
Average                   €27.16
Typical category          Groceries

[monthly chart]

Transactions
...

AI insight:
“Your Lidl spending has been stable over the last six months.”
```

Merchant pages should support:

- spending totals,
- transaction count,
- average purchase,
- category distribution,
- account distribution,
- time trends,
- recurring behavior if relevant,
- transaction list,
- AI insights,
- related tags/events.

Merchant identity normalization should connect differently formatted bank descriptions to the same merchant entity.

## 78.11 Money AI Integration

The persistent AI panel must understand the active Money context.

Examples:

From Transactions:

> “Show only restaurant purchases above €20.”

From an account:

> “What do I mainly use this account for?”

From Recurring:

> “Which subscriptions increased in price?”

From a merchant:

> “How has my spending here changed this year?”

From Review:

> “Resolve the obvious transfers.”

AI actions that modify canonical financial data should use the system's finance tools, preserve history, and remain undoable.

## 78.12 Money UX Principles

The Money section should follow these rules:

- dense but readable,
- keyboard-friendly,
- table-first where appropriate,
- strong filtering/search,
- AI available everywhere but not required,
- drill-down without excessive page navigation,
- raw source always inspectable,
- AI confidence visible where useful,
- bulk operations supported,
- every AI/user correction auditable and undoable.


---

# 79. Plan Section — Target Product Design

The Plan section is now defined as the forward-looking control center of the product.

Primary structure:

```text
Plan

Overview
Goals
Spending Plans
Scenarios
Forecast
Financial Model
```

The core question Plan should answer is:

> “Given where I am financially, where am I going and what can I change?”

Home focuses primarily on the present state of the user's finances. Plan focuses on future outcomes, decisions, tradeoffs, and assumptions.

## 79.1 Plan Overview

Plan Overview should summarize the user's financial trajectory.

Example:

```text
Your next 12 months

Projected cash
€4,120 ──────────────── €6,840
          [forecast]

On track
Japan          Jul 2027     ✓
Emergency      Dec 2026     ✓

Needs attention
Laptop         Mar 2027     2 months behind

Upcoming major changes
Oct     Rent €390
Dec     Christmas spending ~€300
Apr     Japan flights ~€900

AI outlook
“At your current pace, your financial position
should improve by roughly €2,700 over 12 months.”
```

The page may include projected balances, goal status, major planned expenses, expected cash-flow changes, identified risks, plan conflicts, AI-generated outlook, and quick links to scenarios and goals.

## 79.2 Goals

Goals are first-class planning objects and should show target progress, expected completion, required monthly pace, current pace, forecast, contribution history, key influencing behaviors, related scenarios, artifacts, and dashboards.

Key actions:

```text
Adjust goal
Run scenario
Ask AI
```

## 79.3 Virtual Goal Allocations

Goals may reserve portions of actual account balances conceptually without moving money.

Example:

> “€2,000 of my Commerzbank balance is reserved for Japan.”

This creates a virtual allocation in the financial model and affects available-to-spend, planning, forecasts, goal status, and scenario calculations.

## 79.4 Spending Plans

Spending Plans are AI-first rather than beginning with dozens of manual category caps.

Primary action:

> **Create a plan with AI**

Example:

> “I want to save more without cutting travel.”

AI should analyze actual historical behavior and propose a realistic plan. Traditional manual category budgeting remains available underneath.

## 79.5 Planned vs Actual

The system continuously compares planned, actual, and projected end-of-period outcomes.

It should avoid treating tiny deviations as failure and instead interpret whether the overall financial objective is still on track.

## 79.6 Scenarios

Scenarios compare directly against the current real baseline.

Example scenario variables:

```text
Flights       €900
Hotel       €1,200
Daily spend    €70
Duration       21 days
Departure      Jul 2027
```

Changing a variable should immediately recalculate the scenario using the forecasting engine. AI can explain sensitivity and impacts on other goals.

## 79.7 Forecast

Forecast has its own dedicated page with a detailed financial timeline and multiple projection bands.

Expected / Conservative / Optimistic projections must come from the deterministic forecasting engine and explicit uncertainty assumptions, not separate LLM guesses.

Users can inspect any point and ask questions such as:

> “Why does my balance drop here?”

## 79.8 Financial Model

Financial Model is the transparent “under the hood” view of the planning system.

Suggested sections:

```text
Income assumptions
Regular expenses
Variable spending assumptions
Safety rules
Account behavior
Goal allocations
Forecast assumptions
User rules
AI-learned facts
```

Each assumption exposes its current value, source, confidence where inferred, and edit/remove controls.

## 79.9 Plan Conflict Detection

The system should actively identify conflicts between goals, spending plans, and scenarios.

Example:

> “Japan, the laptop purchase, and your emergency-fund target cannot all happen by their current dates under the expected forecast.”

The system should explain why and offer resolution options such as delaying a goal, reducing a target, increasing savings, reducing selected spending, changing priorities, changing assumptions, or comparing alternative scenarios.

## 79.10 Plan AI Integration

The persistent AI panel understands the active planning context.

Examples:

> “How can I get this goal back on track without reducing travel?”

> “Make this scenario pessimistic.”

> “What causes the lowest forecast point in February?”

> “Why do you assume €260/month for groceries?”

AI changes to planning assumptions use canonical finance tools, update affected projections, preserve audit history, and remain undoable.

## 79.11 Plan UX Principles

Plan should feel:

- forward-looking,
- interactive,
- explainable,
- scenario-driven,
- grounded in deterministic calculations,
- conversational without requiring chat,
- connected to the user's own goals and rules,
- transparent about assumptions and uncertainty.


---

# 80. AI Section — Target Product Design

The AI section is now defined as the intelligence center of the product.

Primary structure:

```text
AI

Chat
Deep Analysis
Library
Activity
```

The persistent AI side panel remains available throughout the product, while this full AI area is intended for longer-form work, saved analyses, artifact management, and AI history.

## 80.1 Chat

Chat should feel like a financial workspace rather than a generic chatbot.

Recommended layout:

- left: persistent conversation threads,
- center: main conversation,
- right: current artifact / analysis / evidence preview when relevant.

A conversation may contain:

- normal AI answers,
- evidence,
- finance-tool activity,
- artifact previews,
- analysis summaries,
- system state changes.

Context should be visible through removable context chips such as:

```text
Japan Goal
Commerzbank
September transactions
```

The user can remove context before sending a message.

## 80.2 Inline AI Tool Activity

While AI is working, actual operational activity should appear inline.

Example:

```text
Checking your finances...

✓ Loaded financial model
✓ Read 12 months of transactions
✓ Checked recurring expenses
● Running Japan scenario
○ Reviewing result
○ Building artifact

[Stop]
```

This is not hidden chain-of-thought.

It is a visible record of the actual finance tools/data operations relevant to the user's request.

After completion, it can collapse into a compact element such as:

```text
12 actions · View activity
```

This preserves transparency without overwhelming the conversation.

## 80.3 Deep Analysis Area

Deep Analysis should have its own dedicated screen rather than being buried inside chat history.

Example:

```text
Deep Analysis

Latest
September Financial Review
Completed Sep 12

Overall financial health
Cash flow
Spending patterns
Recurring costs
Risks
Goals
Recommendations
Generated artifacts

[Open full review]

Previous analyses
June 2026
March 2026
...
```

Starting a new analysis uses a simple flow:

> **Run Deep Analysis**

with an optional instruction:

> “Anything you want me to focus on?”

If left blank, the system runs the full comprehensive analysis.

The UI should not expose a cluttered list of many predefined analysis types.

## 80.4 Library

AI → Library is the central place for saved AI-created material.

Recommended tabs:

```text
Library

Artifacts | Analyses | Conversations
```

Artifacts should support:

- search,
- sorting,
- opening,
- pinning,
- duplicating,
- editing,
- exporting,
- deleting,
- viewing versions,
- viewing activity.

Analyses preserve historical reviews.

Conversations preserve normal persistent threads.

Global search / command palette can find all of these resources as well.

## 80.5 Artifact Creation Inside Chat

Artifact generation should feel integrated with the conversation.

Example:

```text
Japan Affordability Planner
────────────────────────────
[interactive preview]

[Open full screen]
[Pin]
[Edit]
[•••]
```

Artifacts should remain visually associated with the message/run that created them while also existing independently in Library.

Later user instructions should modify the same artifact where appropriate.

Example:

> “Make the pessimistic case more pessimistic.”

This should create a new artifact version rather than silently generating a completely separate artifact.

## 80.6 Evidence in AI Answers

Evidence should be a first-class part of AI answers.

Example claim:

> “Your discretionary spending rose 18%.”

The UI should provide a way to inspect the supporting calculation and transactions.

Possible pattern:

```text
View evidence
```

For complex answers, claims may have compact evidence indicators rather than showing all underlying raw data inline.

AI should clearly communicate uncertainty when evidence is weak or ambiguous.

## 80.7 AI Activity

AI → Activity provides a complete history of AI operations across the product.

Example:

```text
Today

14:42  Japan scenario
       9 finance queries · 2 forecasts · 1 artifact modified

13:18  Transaction cleanup
       84 transactions read · 12 modified

11:04  Deep Analysis
       2,438 transactions · 3 accounts · 4 artifacts
```

Opening a run should show:

- data accessed,
- tools called,
- canonical data changed,
- artifacts created/modified,
- model used,
- provider used,
- duration,
- artifact versions,
- whether the run completed, failed, or was stopped.

For Custom AI mode, Activity may also show:

- model/provider usage,
- token usage,
- estimated/actual cost when available.

## 80.8 AI Configuration Location

Model and prompt configuration should **not** live inside the daily AI workspace.

It belongs under:

```text
Settings → AI
```

Reason:

> it configures the intelligence system rather than being part of daily financial work.

Normal mode users can inspect product-defined prompts/model behavior there.

Custom mode unlocks model selection and prompt editing as previously defined.

## 80.9 AI UX Principles

The AI experience should be:

- persistent,
- contextual,
- observable,
- evidence-backed,
- cancellable,
- tool-driven,
- artifact-aware,
- thread-based,
- transparent about data access,
- able to modify canonical financial state through explicit finance tools,
- never dependent on hidden opaque arithmetic for financial results.



---

# 81. Settings — Target Product Design

Settings is now defined as a powerful but secondary configuration area that stays out of normal daily finance workflows.

Primary structure:

```text
Settings

General
Data & Imports
Financial Rules
Notifications
AI
Privacy & Security
Appearance
Advanced
```

## 81.1 General

General settings should include:

```text
Name
Base currency
Locale
Timezone
Start of week
Number/date formatting
Default dashboard
Default forecast horizon
```

Base currency is a global workspace preference.

Individual accounts and transactions continue to retain their native currencies.

## 81.2 Data & Imports

Data & Imports manages ingestion and portability.

Suggested sections:

```text
Imported / connected accounts
Default import behavior
Import history
Duplicate detection
Merchant normalization
Category taxonomy
Export data
Backup / restore
Imported source files
```

Users should have strong data portability.

V1 should support exporting at least:

- normalized transactions as CSV,
- full workspace data as JSON or another structured format,
- artifacts,
- audit history where practical.

The product should avoid locking users into proprietary data structures without an export path.

For V1, Backup / restore means documented operator-managed recovery plus user data export. A self-service workspace restore/import-of-backup UI is deferred; do not present an operator disaster-recovery procedure as a working user feature.

## 81.3 Financial Rules

Financial Rules are managed as explicit first-class objects.

Examples:

```text
Always keep €500 in Commerzbank
Do not count ETFs as spendable money
Transfers to Scalable count as savings
```

Each rule should expose:

- what it affects,
- source,
- created by user or AI,
- last modified,
- edit,
- disable,
- delete.

Disable is preferred over forcing permanent deletion when a user only wants a rule temporarily inactive.

## 81.4 Notifications

Notifications should be granular.

Potential notification categories:

```text
Unusual charges
Subscription price changes
Low projected balance
Goal falling behind
New recurring payment
Deep Analysis finished
Artifact scheduled refresh
Important recommendation
Weekly financial summary
```

For initial desktop V1, notification delivery can focus on:

```text
Off
In-app
```

Email/push channels may be added later.

A high-level AI proactivity control should also exist:

```text
AI Proactivity

Low
Balanced
High
```

This controls how readily the product surfaces recommendations and non-critical AI observations.

It should not suppress core safety/financial-risk alerts that are explicitly enabled.

## 81.5 AI Settings

Settings → AI is the configuration center for the intelligence layer.

Suggested structure:

```text
AI Mode
Models
Prompts
Providers
Usage
Data Access
```

### Included AI

```text
● Included AI
○ Custom AI
```

Included AI uses product-controlled model routing through OpenRouter.

In this mode:

- model routing is controlled by the product,
- prompts are visible,
- prompts are read-only.

### Custom AI

Custom AI allows supported user-provided provider/API configurations.

In Custom mode users can:

- connect supported providers,
- choose models per capability,
- edit capability-specific prompts,
- restore the product default prompt.

## 81.6 Custom Model Mapping

Only Custom mode allows per-capability model selection.

Example:

```text
Financial Assistant    [model]
Deep Analysis          [model]
Classification         [model]
Artifact Planner       [model]
Artifact Builder       [model]
Artifact Reviewer      [model]
Recommendation Engine  [model]
```

The exact capability list may expand as the product evolves.

## 81.7 Prompt Management

Prompts remain capability-specific rather than being one global system prompt.

Normal mode:

> View only.

Custom mode:

> Edit + Restore default.

No end-user prompt-testing workflow is required; product-managed prompts still require offline evaluation.

No user-facing default prompt version history is required; internal versions remain required.

## 81.8 AI Usage

AI Usage should expose useful transparency.

Potential metrics:

- AI run count,
- model usage,
- provider usage,
- token usage,
- included AI usage,
- custom-provider cost where available.

This is especially important for power users and Custom AI mode.

## 81.9 AI Data Access

Settings should include an informational page showing what categories of financial data AI can access.

Example:

```text
Transactions
Balances
Goals
Financial Model
Investments
Artifacts
Rules
Analysis history
```

This is not a per-query approval wall.

Users should instead have broad exclusion controls where needed.

Examples:

> Exclude this account from AI analysis.

> Track this asset for net worth but do not expose it to AI tools.

These exclusions should be respected by AI, Deep Analysis, recommendations, and artifact generation where relevant.

Exclusion also applies to generated-artifact data queries and to derived aggregates, evidence and cached conversation context. An excluded object can remain in ordinary net-worth/finance views. AI results based on an eligible subset must state that coverage; they cannot claim to represent the whole workspace. Changing an exclusion invalidates affected AI context and stops/restarts affected work before further disclosure. Previously transmitted provider data cannot be recalled; explain this when changing the setting. This is separate from excluding a transaction from ordinary analytics or an account from spendable cash.

## 81.10 Privacy & Security

Suggested sections:

```text
Active sessions
Sign out other sessions
Data retention
Export all data
Delete account/data
Security log
Artifact permissions
```

Artifact permissions should be inspectable and revocable.

Example:

```text
Japan Planner

Balances ✓
Goals ✓
Recurring ✓
Raw transactions ✕
Investments ✕
```

The normal UX remains observable rather than approval-heavy.

## 81.11 Appearance

Appearance settings may include:

```text
Theme:
Light
Dark
System

Density:
Comfortable
Compact

Dashboard grid size
Table row density
```

Compact density is especially important for transaction-heavy power users.

## 81.12 Advanced

Advanced settings can contain technical or rarely used controls.

Examples:

```text
Developer mode
Artifact code editor defaults
Show raw IDs
Verbose AI activity
Experimental features
Reset learned merchant rules
Rebuild derived analytics
Re-run categorization
```

Developer mode can unlock deeper artifact debugging and lower-level tool details without cluttering the standard product.

## 81.13 AI Preferences

AI Preferences should be conceptually separate from Financial Rules.

Example preferences:

```text
Be conservative when estimating affordability
Do not recommend cutting travel
Prioritize emergency fund over optional purchases
Keep recommendations concise
```

Important distinction:

**Financial Rules**
- deterministic,
- directly affect calculations/system behavior.

**AI Preferences**
- influence communication style,
- influence recommendation framing,
- influence reasoning priorities,
- do not directly rewrite deterministic financial calculations unless converted into an explicit rule.

This distinction should remain visible to the user.



---

# 82. Shared Systems — Target Product Design

The shared systems below describe the target product, delivered according to the release baseline. They connect Home, Money, Plan, AI, Settings, and generated artifacts into one coherent workspace.

## 82.1 Persistent AI Side Panel

The AI side panel should:

- slide in from the right,
- remain available from every major screen,
- be resizable,
- stay open while the user navigates,
- preserve the active conversation thread,
- understand the current page/object as context,
- show removable context chips,
- support normal chat, evidence, tool activity, and artifacts.

Example contexts:

```text
Context:
Commerzbank
Japan Goal
September transactions
```

When the user navigates, the current contextual attachment may update automatically.

The user can manually pin context when they want it to persist across navigation.

The side panel should also expose compact live AI activity while a run is active.

## 82.2 Global Command Palette

The product should provide a global command/search palette using:

```text
Ctrl+K / Cmd+K
```

It should support both exact navigation and natural-language intent.

Searchable targets include:

- transactions,
- accounts,
- merchants,
- categories,
- recurring items,
- goals,
- scenarios,
- artifacts,
- dashboards,
- analyses,
- conversations,
- settings,
- commands.

Examples:

```text
open Japan dashboard
Spotify
transactions in Paris
show restaurant spending this month
create new scenario
why was March expensive
```

Behavior:

- direct navigation/action requests execute or navigate immediately,
- analytical questions hand off seamlessly to AI,
- results should remain keyboard-friendly and fast.

## 82.3 Notification Center

The application should provide a unified notification center, accessible from a bell/global notifications control.

It may contain:

- unusual financial activity,
- important recommendations,
- finished Deep Analysis jobs,
- completed imports,
- import/review issues,
- scheduled artifact refreshes,
- goal warnings,
- forecast warnings,
- system messages.

Notifications should be grouped/ranked by importance.

Where possible, notifications include direct actions.

Examples:

```text
Subscription price increased
Spotify: €10.99 → €12.99

[View] [Ignore]
```

```text
Deep Analysis finished

[Open analysis]
```

Notifications should deep-link to the exact underlying account, transaction set, recommendation, artifact, analysis, or evidence.

## 82.4 Import Workflow

Import should use a dedicated workflow.

Recommended sequence:

```text
Select / drag files
      ↓
AI detects file formats and accounts
      ↓
Preview inferred mapping
      ↓
User corrects only if needed
      ↓
Start import
      ↓
Background processing
      ↓
Summary + Review items
```

Once started, import becomes a background job.

The user can navigate elsewhere while processing continues.

Example completion summary:

```text
842 rows processed
91 new transactions
747 matched existing
4 pending review
0 rejected
```

Messy or uncertain rows should generally go to Financial Review instead of blocking the entire import.

## 82.5 Artifact Editor

Full-screen artifact editing should use a workspace-style interface.

Recommended tabs:

```text
Preview
Code
Data
Activity
Versions
```

Preview is the default.

The persistent AI side panel remains available while editing.

Examples:

> “Make this chart smaller.”

> “Add a conservative scenario.”

> “Use weekly instead of monthly.”

Direct code edits are allowed.

Before a code change becomes the active artifact version, the system should run sandbox/runtime validation.

If an edit breaks the artifact, the user can restore the last working version.

The editor must clearly distinguish:

```text
Save artifact state
```

from:

```text
Apply changes to Financial Model
```

Artifact-local interactions must never silently modify canonical financial assumptions.

## 82.6 Shared Background Job System

Long-running operations should use one shared background-job infrastructure.

Examples:

- Deep Analysis,
- imports,
- scheduled artifact AI refresh,
- large re-categorization,
- financial model rebuild,
- derived analytics rebuild,
- bulk transaction analysis.

A global status indicator may show:

```text
2 tasks running
```

Opening it should show:

- task name,
- current stage,
- progress,
- started time,
- relevant activity,
- Stop when supported.

When a task completes:

- its result remains available in the relevant product area,
- an appropriate notification is created.

This avoids every product feature implementing its own incompatible progress model.

## 82.7 Deep Links Into Evidence

Evidence should be navigable throughout the product.

If an AI claim, recommendation, notification, chart, forecast, analysis finding, or artifact refers to specific underlying financial records, the user should be able to jump directly to those records.

Examples:

- claim → filtered transaction view,
- recommendation → contributing merchants/categories,
- chart point → relevant date-range transactions,
- recurring warning → recurring object + history,
- forecast drop → timeline event + contributing assumptions.

This principle should connect otherwise separate parts of the application and reinforce explainability.

## 82.8 Shared Interaction Principles

Across all shared systems:

- context should be visible,
- operations should be cancellable where practical,
- AI activity should be observable,
- canonical changes should be auditable,
- state-changing actions should remain undoable where possible,
- evidence should be one click away,
- background work should not unnecessarily block foreground use,
- exact navigation and AI workflows should feel like parts of one system rather than separate products.

---

# 83. Product Definition Status

The product direction and staged scope are ready to drive the next planning discussion. R1 preserves editable live code artifacts and the trustworthy finance/AI loop. R2/R3 retain the broader vision without holding the first validation release hostage to it.

Before final deployment commitments, verify provider entitlements and qualify actual models on the intended financial tasks. Funding and international AI processing are accepted; development free-model permissions remain separate from customer-data policy. The architecture records the finite feasibility gates. These are implementation proofs, not grounds to keep adding speculative architecture.

The next artifact is the future epoch/story backlog; it does not yet exist. Every R1 row in the Delivery baseline must map to acceptance evidence when that backlog is written. Completion of this document is not proof of implemented or tested software.
