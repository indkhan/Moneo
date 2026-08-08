# Moneo

Expo/React Native personal-finance prototype for iOS, Android, and web. Uses Expo Router and one shared UI component: `src/components/finance-workspace.tsx`.

- Routes in `src/app/`: Dashboard, Transactions, Budgets, Investments, Recurring, and AI Workspace.
- Desktop (>=1024px): sidebar + multi-column workspace. Mobile: stacked content + bottom navigation.
- Web users can import complete Commerzbank CSV files automatically. Clear generic CSV shapes have columns prefilled; ambiguous files use manual mapping. Imports validate corrected dates and currencies and preserve raw rows, references, original files, and row-level errors.
- Accounts, import history, mappings, files, and normalized transactions stay locally in IndexedDB. Exact files and overlapping transactions are skipped with visible counts.
- Dashboard cash flow is calculated per currency without conversion; transaction details show normalized and original bank fields. Sample financial cards were removed.
- Bad rows can be corrected, skipped explicitly, or cancelled before storage. Import deletion removes its source file and transactions.
- No login, cloud/backend, PDF import, bank connection, Moneo category assignment, recurring detection, investment feed, real AI, notifications, or working settings exists yet.
- Helpers cover navigation, responsive layout, CSV parsing/mapping, deduplication, local storage, transaction display, and cash-flow summaries in `src/lib/`.
- `extra/transaction-categorization-plan.html` and `extra/transaction-categorization-implementation-plan.md` document the proposed local category system; neither changes product behavior.

Run with `npm start`; run helper tests with `npm test`.

AI work is recorded as immutable, per-task Markdown entries in `logbook_ai/`; see `AGENTS.md` for the convention.
