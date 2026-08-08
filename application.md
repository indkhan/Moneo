# Moneo

Expo/React Native personal-finance prototype for iOS, Android, and web. Uses Expo Router and one shared UI component: `src/components/finance-workspace.tsx`.

- Routes in `src/app/`: Dashboard, Transactions, Budgets, Investments, Recurring, and AI Workspace.
- Desktop (>=1024px): sidebar + multi-column workspace. Mobile: stacked content + bottom navigation.
- Dashboard shows net worth, spending, budgets, transactions, accounts, recurring payments, investments, AI insight, and pinned example cards.
- The net-worth chart is interactive; navigation works; AI supports local canned messages and chart/table tabs.
- All financial data and AI output are hard-coded sample data. No login, database, bank/API connection, persistence, real AI, notifications, or working settings/pinning exists yet.
- Helpers: navigation (`src/lib/navigation.mjs`), responsive breakpoint (`src/lib/responsive-layout.mjs`), net-worth chart math (`src/lib/net-worth-chart.mjs`).

Run with `npm start`; run helper tests with `npm test`.
