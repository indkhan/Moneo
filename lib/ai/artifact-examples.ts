/** Mercury-inspired look shared by every example, so the gallery reads as one family. */
const design = `Design (Mercury style): canvas #fbfcfd, cards #ffffff or lavender #edecfb with 12px radius, 32px padding and no shadows. Text ink #28253b, secondary #554e7b, 1px rules #c3c3cc. One accent, indigo #5266eb; data colours only indigo, periwinkle #9cb4e8 and lavender, plus a soft coral #f0806c for overspend. Inter at light weights (body 360–400, headings 480, never bold); big numbers 48–60px; small uppercase eyebrows with 0.28px tracking. Buttons and filters are 40px pills: the main action solid indigo, others indigo at 10%. Centred, generous whitespace, responsive (cards stack on mobile). Show money with currency, and a friendly empty state when there is no data.`;

export const artifactExamples = [
  { title: "Monthly money story", summary: "Income, spending and where it went this month.",
    prompt: `Build a "Monthly money story" for the current month, with a month picker. Use cashflow for income, spending and net, and investigate for spending by category (horizontal bars) and the top 5 merchants. Lead with a one-line plain-English summary and three stat cards.` },
  { title: "Goals tracker", summary: "Progress and projected finish date for each goal.",
    prompt: `Build a "Goals tracker". Use goals for each savings goal: a progress ring, saved vs target and amount left. Use cashflow over the last 3 months for the average monthly net, then project a finish date per goal and mark goals that are on or off track.` },
  { title: "Subscription radar", summary: "Recurring charges and what they cost per year.",
    prompt: `Build a "Subscription radar". Use transactions and investigate over the last 6 months to find merchants charged at regular intervals with similar amounts. List each with its typical amount, cadence, last charge and next expected date; show total monthly and yearly cost at the top.` },
  { title: "Net worth snapshot", summary: "Balances across accounts and currencies.",
    prompt: `Build a "Net worth snapshot". Use balances and accounts: a total per currency (never add different currencies together), a donut of balance by account, and a list of accounts showing how old each balance is.` },
  { title: "Spending heatmap", summary: "Every day of spending at a glance.",
    prompt: `Build a "Spending heatmap" of daily spending over the last 90 days as a calendar grid (lavender to indigo by amount). Use transactions; clicking a day lists that day's transactions. Show the busiest weekday and highest day.` },
  { title: "Merchant deep-dive", summary: "Trend, frequency and average spend for any merchant.",
    prompt: `Build a "Merchant deep-dive" with a merchant search box, starting with my top merchant from investigate. For the chosen merchant show total spent, visit count, average ticket, a monthly trend chart over 12 months and the latest transactions.` },
].map(example => ({ ...example, prompt: `${example.prompt}\n\n${design}` }));
