# 2026-08-22 12:27 — agent: categorization v2 (phrase matching, dictionary, internal transfers)

## Requested

Find and implement the simplest best way to categorize transactions, informed by how similar products do it and by the real Commerzbank/Revolut CSVs in `extra/`. Deliver step by step with one commit per step.

## Research conclusion

Web research (Swedbank tech blog, Monarch, Copilot help docs, German open-source tools ledgerly/ing-bankstats/DKB dashboards) converged on the same pipeline: clean counterparty → keyword/phrase dictionary → learn from user corrections → abstain when unsure. ML/LLM/cloud enrichment is a later layer nobody starts with. Moneo already had the architecture (src/lib/transaction-categorization.mjs); exact-equality alias matching was the gap.

## What was done (4 commits)

1. `1d4faf4` feat: match counterparty categories by contained merchant phrase — `aliasMatch` now prefers exact key match, then whole-word phrase containment (min alias length 4; word-boundary via existing `hasPhrase`). Evidence distinguishes "Exact counterparty" vs "Counterparty match".
2. `e09f5cb` feat: seed merchant dictionary from real Commerzbank and Revolut rows — ~45 aliases across groceries/restaurants/transit/fuel/utilities/subscriptions/pharmacy/insurance/education/investments/tickets; new subcategories `health.insurance`, `shopping.subscriptions`, `leisure.tickets`, `financial.investments`; direction-gated income employer rules (`direction: 'incoming'` for PCC GmbH / 3kb).
3. `5d250c8` feat: auto-label internal transfers and exclude them from spending — markers `to pocket` / `pocket withdrawal` / `open banking top up` assign new built-in category `transfer.internal` at high confidence (user rules still win); `dashboard-spending.mjs` skips that category so spending totals stay honest.
4. `e054a2d` feat: cover remaining merchants found in full statement sweep — Primark, Coop, Bereket, Frischmarkt, Blumen/blumenladen, Pommes, Deutsche Post.

## Why

Phrase containment is what every comparable tool does (Monarch "contains", Copilot partial rules); exact equality missed most Commerzbank card payments ("NETTO MARKEN-DISCOU AM MARKT 1 SAAR"). Person-to-person transfers deliberately stay in Needs category: guessing them would be wrong more often than right; personal rules are the intended mechanism.

## Validation

- `npm test`: 94 pass, 0 fail.
- `npx tsc --noEmit`: clean.
- Throwaway coverage script over both real CSVs (503 rows): 284 auto-assigned (56%), 19 medium suggestions, 200 unmatched — of which the large majority are person-to-person transfers/exchanges/cash that should stay uncategorized by design.

## Files

- src/lib/transaction-categorization.mjs (+ test)
- src/lib/dashboard-spending.mjs (+ test)
- application.md (also carries an earlier session's pending roadmap line, committed together to avoid partial-file surgery)

## Risks / follow-up

- Cross-bank internal transfer pairing (Commerzbank row ↔ Revolut row) still deferred; text markers only catch Revolut-side movements.
- Rundfunk broadcasting fee, ATM cash withdrawals, wizzair left uncategorized (no clean taxonomy slot yet) — personal-rule territory or future taxonomy additions.
- Dictionary maintenance is manual; revisit if precision drops as new merchants appear.
