import { CALCULATOR_RUNTIME, type ArtifactKind } from "./spec";

// Reviewed, deterministic starting points for the Library. They are NOT AI
// output and are NOT trusted more than user code: creating one still goes
// through create_trusted_artifact and then the same validated CAS save as any
// edited calculator (lib/artifacts/save-version.ts).

export type LibraryTemplate = {
  id: string;
  name: string;
  description: string;
  kind: ArtifactKind;
  // Native templates (trip planner) use the built-in host UI without generated code.
  build?: (today: string) => { source: string; manifest: Record<string, unknown> };
  // Static illustration when synthetic fixtures cannot show the idea; otherwise previews run the code.
  sample?: Record<string, unknown>;
};

const budgetTracker = `(input) => {
  const s = input && input.snapshot ? input.snapshot : {};
  const p = s.spending;
  if (!p || p.unavailable || p.spendingMinor === undefined) return { unavailable: (p && p.unavailable) || s.unavailable || "Spending evidence is unavailable" };
  const budget = BigInt(input.params.monthlyBudgetMinor || 0);
  const spent = BigInt(p.spendingMinor);
  const days = Array.isArray(p.daily) ? p.daily : [];
  let run = 0n;
  let exact = true;
  const labels = [];
  const values = [];
  for (const day of days) {
    run += BigInt(day.spendingMinor || "0");
    const n = Number(run);
    if (!Number.isSafeInteger(n)) exact = false;
    labels.push(String(day.date).slice(5));
    values.push(n);
  }
  const used = budget > 0n ? Number(spent * 1000n / budget) / 10 : null;
  const over = budget > 0n && spent > budget;
  return {
    summary: budget === 0n ? "Set a monthly budget to track this month's spending against it."
      : over ? "Over budget: spending has passed this month's budget (" + used + "% used)."
      : used + "% of this month's budget used from " + p.from + " to " + p.to + ".",
    numbers: { budgetMinor: String(budget), spentMinor: String(spent), remainingMinor: String(budget - spent), budgetUsed: used === null ? "n/a" : used + "%" },
    warning: p.partial ? "Some transactions await classification review and are excluded from spending." : exact ? "" : "Chart omitted: amounts exceed the exact numeric range.",
    ...(exact && labels.length ? { chart: { labels, values, type: "line", label: "Cumulative spending (minor units)" } } : {})
  };
}`;

const savingsRate = `(input) => {
  const s = input && input.snapshot ? input.snapshot : {};
  const c = s.cashflow;
  if (!c || c.unavailable || c.incomeMinor === undefined) return { unavailable: (c && c.unavailable) || s.unavailable || "Cashflow evidence is unavailable" };
  const income = BigInt(c.incomeMinor);
  const spending = BigInt(c.spendingMinor);
  const saved = income - spending;
  const target = BigInt(Math.round(Number(input.params.targetRatePercent || 0)));
  if (income <= 0n) return { unavailable: "No income recorded from " + c.from + " to " + c.to + "; a savings rate needs income." };
  const rate = Number(saved * 1000n / income) / 10;
  const maxSpending = income * (100n - target) / 100n;
  const values = [income, spending, saved].map(Number);
  const exact = values.every(Number.isSafeInteger);
  return {
    summary: "Savings rate " + rate + "% from " + c.from + " to " + c.to + (rate >= Number(target) ? ", at or above your " : ", below your ") + String(target) + "% target.",
    numbers: { incomeMinor: String(income), spendingMinor: String(spending), savedMinor: String(saved), savingsRate: rate + "%", targetRate: String(target) + "%", spendingLimitForTargetMinor: String(maxSpending) },
    warning: c.partial ? "Some transactions await classification review and are excluded." : "",
    ...(exact ? { chart: { labels: ["Income", "Spending", "Saved"], values, label: "This period (minor units)" } } : {})
  };
}`;

const subscriptionAudit = `(input) => {
  const s = input && input.snapshot ? input.snapshot : {};
  const inv = s.investigation;
  if (!inv || !Array.isArray(inv.groups)) return { unavailable: s.unavailable || "Merchant evidence is unavailable" };
  const minMonths = Math.max(1, Math.round(Number(input.params.minMonths || 2)));
  const names = {};
  const items = inv.records && Array.isArray(inv.records.items) ? inv.records.items : [];
  for (const item of items) if (item.merchantId && !names[item.merchantId]) names[item.merchantId] = String(item.description || "").slice(0, 60);
  const merchants = {};
  for (const g of inv.groups) {
    const id = g.dimensions ? g.dimensions.merchant : null;
    if (!id || g.currentMinor === null || g.currentMinor === undefined) continue;
    const key = id + "|" + g.currency;
    const entry = merchants[key] || (merchants[key] = { id, currency: g.currency, months: 0, total: 0n });
    const amount = BigInt(g.currentMinor);
    entry.total += amount < 0n ? -amount : amount;
    entry.months += 1;
  }
  const recurring = Object.values(merchants).filter((m) => m.months >= minMonths)
    .sort((a, b) => (b.total > a.total ? 1 : b.total < a.total ? -1 : 0));
  const currencies = [...new Set(recurring.map((m) => m.currency))];
  let yearly = 0n;
  const rows = recurring.slice(0, 20).map((m) => {
    const monthly = m.total / BigInt(m.months);
    yearly += monthly * 12n;
    return { merchant: names[m.id] || "Merchant " + String(m.id).slice(0, 8), currency: m.currency, monthsSeen: m.months, averageMonthlyMinor: String(monthly), yearlyEstimateMinor: String(monthly * 12n) };
  });
  return {
    summary: rows.length ? rows.length + " merchant(s) charged you in at least " + minMonths + " separate months from " + inv.interpretedFilters.period.from + " to " + inv.interpretedFilters.period.to + "."
      : "No merchant charged you in " + minMonths + " or more separate months in this period.",
    rows,
    numbers: { recurringMerchants: recurring.length, ...(currencies.length === 1 ? { yearlyEstimateMinor: String(yearly), currency: currencies[0] } : {}) },
    warning: (currencies.length > 1 ? "Merchants charge in several currencies; yearly totals are shown per row only. " : "") + (inv.coverage && inv.coverage.partial ? "Some records await review or conversion and are excluded. " : "") + "Repeated monthly charges suggest, but do not prove, a subscription."
  };
}`;

function monthsBack(today: string, months: number) {
  const date = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.toISOString().slice(0, 10);
}

export const LIBRARY_TEMPLATES: LibraryTemplate[] = [
  {
    id: "budget-tracker",
    name: "Budget tracker",
    description: "Track this month's spending against a monthly budget, with a cumulative spending line.",
    kind: "custom_tracker",
    build: () => ({ source: budgetTracker, manifest: { kind: "custom_tracker", runtime: CALCULATOR_RUNTIME, sdk: ["spending"], renderer: "trusted",
      params: { monthlyBudgetMinor: { type: "number", default: 150000, min: 0, max: 100000000000, label: "Monthly budget" } } } }),
  },
  {
    id: "trip-planner",
    name: "Trip planner",
    description: "Plan dated trip payments and see the lowest headroom on your paying account before, during and after the trip.",
    kind: "trip_planner",
    sample: { summary: "Lowest headroom with the trip stays positive.", numbers: { baselineMinor: "150000", tripCostMinor: "90000", minimumHeadroomMinor: "60000" } },
  },
  {
    id: "subscription-audit",
    name: "Subscription audit",
    description: "Find merchants that charged you in several separate months and estimate what they cost per year.",
    kind: "custom_report",
    sample: { summary: "3 merchant(s) charged you in at least 2 separate months.", numbers: { recurringMerchants: 3, yearlyEstimateMinor: "53880", currency: "EUR" },
      rows: [{ merchant: "Streaming service", monthsSeen: 3, averageMonthlyMinor: "1299", yearlyEstimateMinor: "15588" }, { merchant: "Gym", monthsSeen: 3, averageMonthlyMinor: "2990", yearlyEstimateMinor: "35880" }, { merchant: "Cloud storage", monthsSeen: 2, averageMonthlyMinor: "201", yearlyEstimateMinor: "2412" }] },
    build: today => ({ source: subscriptionAudit, manifest: { kind: "custom_report", runtime: CALCULATOR_RUNTIME, sdk: ["spending"], renderer: "trusted",
      params: { minMonths: { type: "number", default: 2, min: 1, max: 12, label: "Minimum months seen" } },
      // ponytail: period is fixed when the tool is created; edit the manifest to move it.
      investigation: { version: 1, period: { from: monthsBack(today, 3), to: today }, groupBy: ["merchant", "month"], metric: "spending", page: { size: 100, period: "current" } } } }),
  },
  {
    id: "savings-rate",
    name: "Savings-rate calculator",
    description: "See this month's savings rate from income and spending, and the spending limit that would meet your target.",
    kind: "custom_planner",
    build: () => ({ source: savingsRate, manifest: { kind: "custom_planner", runtime: CALCULATOR_RUNTIME, sdk: ["cashflow"], renderer: "trusted",
      params: { targetRatePercent: { type: "number", default: 20, min: 0, max: 100, label: "Target savings rate", unit: "%" } } } }),
  },
];

export function libraryTemplate(id: string) {
  return LIBRARY_TEMPLATES.find(template => template.id === id);
}
