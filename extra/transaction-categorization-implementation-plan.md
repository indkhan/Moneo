# Transaction categorization implementation plan

## Goal

Automatically assign a useful Moneo category when local evidence is strong. Leave uncertain transactions in `Needs category`. Let the user correct one transaction or create a reusable rule for the same normalized counterparty.

No transaction data leaves the device.

## Scope chosen for v1

Ship:

- Fixed, versioned two-level Moneo taxonomy.
- Deterministic categorization from normalized transaction fields and selected raw CSV evidence.
- Discrete `high`, `medium`, and `low` confidence.
- Automatic assignment only for `high` confidence.
- Medium-confidence suggestion inside `Needs category`.
- Manual assignment for one transaction.
- One reusable user-rule shape: normalized counterparty to category.
- Option to apply a new user rule to existing matches.
- Stored method, classifier version, and short evidence explanation.
- Category badge, explanation, picker, and `Needs category` count in Transactions.

Defer:

- ML or local LLM.
- Cloud enrichment.
- Custom top-level categories or custom subcategories.
- General-purpose rule builder.
- Category splits.
- Tags.
- Automatic internal-transfer pairing.
- Automatic recategorization after classifier updates.
- Category dashboards and budgets.

These are separate features. None is required to make automatic categorization useful.

## Required import gate

Do not begin category implementation until current import regressions are resolved:

- Correct account separation for files with the same schema.
- Recover malformed rows without losing unrelated valid rows.
- Preserve transfer purpose as a normalized field, not only inside `rawRecord`.
- Preserve and interpret transaction status accurately.
- Fix import deletion provenance and orphan cleanup.
- Verify representative Commerzbank and Revolut exports.

Category tests must use the normalized output of these fixtures. Categorization cannot compensate for incorrect transaction identity or missing evidence.

## Minimal domain model

Add to normalized transactions:

```ts
type TransactionCategoryAssignment = {
  categoryId: string;
  method: "built-in" | "user-rule" | "manual";
  classifierVersion: "moneo-category-v1";
  evidence: string[];
};

type MoneoTransaction = TransactionDraft & {
  id: string;
  accountId: string;
  importId: string;
  category?: TransactionCategoryAssignment;
};
```

Keep the bank's category in `bankCategory`. Never replace it with Moneo's category.

Add one persisted rule type:

```ts
type CategoryRule = {
  id: string;
  counterpartyKey: string;
  categoryId: string;
  createdAt: string;
};
```

No generic condition/action engine in v1.

## Taxonomy

Keep stable machine IDs separate from labels. Initial primary groups:

- `income`
- `housing`
- `utilities`
- `food`
- `transport`
- `shopping`
- `health`
- `leisure`
- `travel`
- `education`
- `financial`
- `gifts`
- `other`

Initial leaf categories should cover only common, confidently detectable cases, for example:

- `income.salary`
- `income.interest`
- `housing.rent`
- `utilities.energy`
- `utilities.internet_phone`
- `food.groceries`
- `food.restaurants`
- `transport.public_transit`
- `transport.fuel`
- `shopping.general`
- `health.pharmacy`
- `leisure.streaming`
- `financial.bank_fee`
- `gifts.donation`
- `other.uncategorized`

Transfers and refunds are transaction roles, not spending categories. Until transfer pairing exists, transfer-like transactions without clear purpose remain uncategorized.

## Pure categorization pipeline

Implement one new pure module: `src/lib/transaction-categorization.mjs`.

It owns:

1. Taxonomy constants.
2. `normalizeEvidenceText(value)`.
3. `counterpartyKeyFor(transaction)`.
4. `extractCategoryEvidence(transaction)`.
5. `categorizeTransaction(transaction, userRules)`.

### Evidence extraction

Use normalized fields first:

- `title`
- `description`
- `sender`
- `recipient`
- normalized transfer purpose
- `bankCategory`
- `transactionType`
- references
- inflow/outflow direction

Read raw CSV values only from recognized semantic header aliases such as:

- purpose / transfer purpose / remittance / verwendungszweck
- category / kategorie
- merchant / payee / recipient / empfänger
- sender / payer / auftraggeber
- booking text / description / buchungstext

Do not search arbitrary raw fields. IBANs, dates, IDs, and unrelated columns create false matches.

### Text normalization

Use platform JavaScript only:

- Unicode `NFKC` normalization.
- Locale-independent lowercase.
- Normalize whitespace and punctuation.
- Remove known card/reference boilerplate only when tested.
- Preserve whole tokens and useful phrases.
- Never match single letters.
- Prefer exact counterparty aliases and whole-word/whole-phrase matches over substrings.

### Decision order

1. Exact user counterparty rule: assign high.
2. Built-in exact merchant/counterparty rule: assign high.
3. Strong purpose phrase plus compatible direction: assign high.
4. Bank category plus independent matching merchant or purpose: assign high.
5. One credible signal only: suggest medium.
6. Conflicting categories or weak evidence: low, no suggestion.

Transaction type is a guard or supporting signal. It never directly decides rent, groceries, entertainment, or other spending intent.

### Return value

```ts
type CategorizationDecision =
  | { status: "assigned"; categoryId: string; confidence: "high"; method: "built-in" | "user-rule"; evidence: string[] }
  | { status: "suggested"; categoryId: string; confidence: "medium"; evidence: string[] }
  | { status: "unmatched"; confidence: "low"; evidence: string[] };
```

No numeric confidence is exposed or stored.

## Built-in rules

Keep rules as plain arrays inside the same module. No framework.

Start with a small German/English high-precision pack:

- Salary phrases: `gehalt`, `lohn`, `salary`, `payroll`, only on inflow.
- Rent phrases: `miete`, `mietzahlung`, `rent`, only on outflow.
- Bank fee phrases and supported transaction types.
- Known grocery counterparties: REWE, EDEKA, ALDI, LIDL, NETTO, KAUFLAND.
- Known public transport counterparties: DB/Deutsche Bahn and local operators only with tested aliases.
- Known streaming counterparties with exact aliases.

Do not try to recognize every merchant. Coverage grows only through representative fixtures and observed failures.

Mark marketplaces such as Amazon, PayPal, Apple, Google, and department stores as ambiguous. They can receive medium suggestions but never high assignments from merchant alone.

## Persistence

Upgrade IndexedDB from version 1 to version 2.

Add only one store:

- `categoryRules`, keyed by `id`, with a unique `counterpartyKey` index.

Category assignments stay on transaction records. IndexedDB does not require a schema change for added object fields.

Add small store functions:

- `saveCategoryRule(database, rule)`
- `setTransactionCategory(database, transactionId, assignment)`
- `applyCategoryRule(database, rule, matchingTransactionIds)` in one transaction
- `saveMissingAutomaticCategories(database, updates)` for one-time backfill

Extend `loadFinanceData` to return `categoryRules`.

### Existing transactions

On database open:

1. Load transactions and rules.
2. Categorize only transactions without `category`.
3. Persist only high-confidence decisions in one IndexedDB transaction.
4. Never overwrite manual or rule-based assignments.

This is idempotent. A new classifier version does not silently change earlier financial results.

### New imports

In `CsvImporter.commitCandidate`:

1. Deduplicate first.
2. Run the pure classifier for accepted transactions.
3. Attach only high-confidence assignments.
4. Store import, source file, transactions, and mapping atomically as today.

## Correction behavior

Category picker offers:

- `This transaction only`: store a manual assignment.
- `All transactions from <counterparty>`: save a counterparty rule and update current matches atomically.

For ambiguous counterparties, default selection is `This transaction only`.

For stable counterparties, default selection is `All transactions from <counterparty>`.

Do not add advanced matching UI in v1. If a counterparty needs multiple categories, user uses individual assignments until a later rule-builder feature is justified.

## UI changes

Keep UI inside `src/components/finance-workspace.tsx`; do not add navigation or architecture.

Transactions panel:

- Show category badge on each row.
- Show `Needs category` when no assignment exists.
- Show count near Transactions title.
- Add `Show needs category` toggle only when unmatched transactions exist.

Expanded transaction detail:

- Show Moneo category.
- Show method: automatic, personal rule, or manual.
- Show short evidence explanation.
- Keep bank category separately labelled as source data.
- Add `Change category` action and inline picker.

No category management screen in v1.

## Tests first

Add `src/lib/transaction-categorization.test.mjs` before implementation.

Required cases:

- REWE plus matching bank category assigns groceries.
- REWE merchant alone still assigns only if exact alias rule is approved.
- Amazon merchant alone remains unmatched or medium.
- Incoming `Gehalt` assigns salary.
- Outgoing `Gehalt` does not assign salary.
- SEPA transfer with `Miete` assigns rent.
- SEPA transfer alone does not become rent or internal transfer.
- Bank category alone produces at most medium.
- User counterparty rule wins over built-in evidence.
- Conflicting strong evidence abstains.
- Matching uses words/phrases, not single letters or accidental substrings.
- Raw source data remains unchanged.
- Same counterparty key is stable across tested statement variants.

Extend `transaction-store.test.mjs` for:

- Version 1 to version 2 migration preserves all records.
- Category rules persist and load.
- Manual assignment changes only the selected transaction.
- Applying a rule updates matching transactions atomically.
- Import deletion does not delete reusable category rules.

No new test framework or dependency.

## File-level change list

New:

- `src/lib/transaction-categorization.mjs`
- `src/lib/transaction-categorization.test.mjs`

Modify:

- `src/lib/transaction-types.ts`: category assignment, rule, and normalized purpose types.
- `src/lib/csv-import.mjs`: expose Commerzbank transfer purpose.
- `src/lib/csv-mapping.mjs`: expose mapped purpose when configured.
- `src/lib/csv-*.test.mjs`: purpose-preservation regressions.
- `src/lib/transaction-store.mjs`: database v2, rule and assignment writes, backfill batch.
- `src/lib/transaction-store.test.mjs`: migration and atomicity coverage.
- `src/components/finance-data-provider.tsx`: load rules and perform idempotent missing-category backfill.
- `src/components/csv-importer.tsx`: categorize accepted transactions before atomic save.
- `src/components/finance-workspace.tsx`: badges, review filter, explanation, and picker.
- `application.md`: concise delivered behavior.
- `backlog.md`: remove delivered category item; retain deferred enhancements.
- `logbook_ai/`: append implementation record.

No dependency changes. No new screen, route, context, service layer, repository abstraction, or generic rules engine.

## Implementation sequence

1. Finish import-quality gate and representative fixtures.
2. Write failing categorization tests.
3. Implement pure evidence normalization and classifier.
4. Add transaction/category types.
5. Write failing IndexedDB migration and update tests.
6. Implement database v2, rules, assignments, and idempotent backfill.
7. Categorize newly accepted imports.
8. Add minimal transaction category UI and correction flow.
9. Run full tests and TypeScript.
10. Verify desktop and mobile with high, medium, low, manual, and learned-rule examples.

## Ship gates

- All existing and new tests pass.
- TypeScript strict check passes.
- Expo web export passes.
- No uncategorized transaction is presented as categorized.
- No automatic decision lacks stored method, version, and evidence.
- Manual choices are never overwritten.
- Bank category and raw CSV remain unchanged and visible.
- Existing IndexedDB data survives upgrade.
- Mobile and desktop category correction flows are usable.

## Expected first release behavior

Moneo will automatically classify a conservative subset of common transactions. Unknown and ambiguous transactions will remain visible under `Needs category`. Each correction can teach one simple reusable counterparty rule. This favors trustworthy coverage over pretending every transaction can be understood locally on day one.
