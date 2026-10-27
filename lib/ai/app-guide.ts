/** What chat tells people about Moneo itself. Keep in step with the navigation in components/app-shell.tsx. */
export const APP_GUIDE = `Moneo is a personal-finance workspace. Pages (link with these paths):
- Overview (/): net worth chart, account balances, cash flow by month, coming payments, goals, budgets and the agent briefing.
- Transactions (/money/transactions): every transaction. Open one to edit its category, merchant, note or tags, split it, link a transfer or refund, or Undo a change. "Add transaction" records cash or other manual entries.
- Organization (/money/organization): give merchants and categories to unorganized rows in bulk, optionally saving a rule.
- Investigations (/money/investigations): saved, exact answers to finance questions.
- Import (/import): drop CSV or XLSX bank exports; rows are matched, deduplicated and reviewed before they count.
- Accounts (/money/accounts): add, rename or archive accounts and set a dated balance (chat can propose one for the user to save). Balances roll forward with later transactions; an account without a balance is left out of net worth.
- Recurring (/money/recurring): subscriptions and bills found from history; confirm or reject them.
- Plan (/plan): cash-flow forecast, goals and scenarios. Spending (/plan/spending): monthly category limits. Currency (/plan/currency): display currency and manual exchange rates.
- Wealth (/money/wealth): investments, assets, debts and money lent to or borrowed from people; these count in net worth.
- Ask (/ai): this chat. The Ask Moneo panel on other pages is the same chat.
- Agent team (/ai/agents): a team of agents (categorizer, recurring detective, anomaly hunter, budget coach, forecaster, insight writer) reviews your data after imports or on request and proposes changes you accept or dismiss. Activity log (/ai/activity): what AI did.
- Artifacts (/ai/artifacts): interactive pages, calculators and dashboards built on request.
- Notifications (/notifications) and Settings (/settings): timezone, locale, theme, AI models, which data AI may read, and scheduled summaries.
In chat you can: ask about your money; say what you spent or received ("I spent €10 on lunch") or attach a receipt photo or PDF to get a card that adds it to Transactions; say you lent or borrowed money to add it to Wealth; ask what the agent team found and accept or dismiss it; ask for charts or an interactive page. Nothing changes until you press the card's button, and every change can be undone.
Keyboard: Ctrl/⌘+K opens the command palette, ? shows shortcuts, G then a letter jumps to a page.`;
