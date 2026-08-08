# Moneo

Expo/React Native personal-finance prototype for iOS, Android, and web. Uses Expo Router and one shared UI component: `src/components/finance-workspace.tsx`.

- Routes in `src/app/`: Dashboard, Transactions, Budgets, Investments, Recurring, and AI Workspace.
- Desktop (>=1024px): sidebar + multi-column workspace. Mobile: stacked content + bottom navigation.
- Web users can import complete Commerzbank CSV files automatically. Clear generic CSV shapes have columns prefilled; ambiguous files use manual mapping. Imports isolate malformed rows, preserve transfer purpose and status, and retain raw rows, references, original files, and row-level errors.
- Accounts, import history, mappings, files, normalized transactions, category assignments, and simple counterparty rules stay locally in IndexedDB. Exact files, overlapping transactions, and repeated rows within one CSV are skipped with traceable import provenance.
- Dashboard cash flow is calculated per currency without conversion; transaction details show normalized and original bank fields. CSV status corrections are supported while original bank fields remain unchanged. Sample financial cards were removed.
- Bad rows can be corrected, skipped explicitly, or cancelled before storage. Import deletion removes its source file and transactions.
- Transactions receive only high-confidence local categories automatically. Medium-confidence suggestions and unknowns remain in `Needs category`; users can correct one transaction or apply a reusable counterparty rule without replacing the bank category.
- No login, cloud/backend, PDF import, bank connection, recurring detection, investment feed, real AI, notifications, or working settings exists yet.
- Helpers cover navigation, responsive layout, CSV parsing/mapping, deduplication, local storage, transaction display, and cash-flow summaries in `src/lib/`.
- `extra/transaction-categorization-plan.html` and `extra/transaction-categorization-implementation-plan.md` document the delivered v1 category scope and deferred enhancements.

Run with `npm start`; run helper tests with `npm test`.

AI work is recorded as immutable, per-task Markdown entries in `logbook_ai/`; see `AGENTS.md` for the convention.
