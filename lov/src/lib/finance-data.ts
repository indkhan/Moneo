export const money = (n: number, currency = "€") =>
  `${n < 0 ? "-" : ""}${currency}${Math.abs(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

export const compact = (n: number, currency = "€") =>
  `${currency}${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

export type Account = {
  id: string;
  name: string;
  institution: string;
  type: "Checking" | "Savings" | "Credit" | "Investment";
  balance: number;
  change: number;
  tone: string;
};

export const accounts: Account[] = [
  {
    id: "a1",
    name: "Everyday",
    institution: "N26",
    type: "Checking",
    balance: 4820.44,
    change: 2.4,
    tone: "oklch(0.62 0.09 168)",
  },
  {
    id: "a2",
    name: "Safety net",
    institution: "Trade Republic",
    type: "Savings",
    balance: 18240.0,
    change: 1.1,
    tone: "oklch(0.74 0.09 210)",
  },
  {
    id: "a3",
    name: "Amex Gold",
    institution: "Amex",
    type: "Credit",
    balance: -1284.17,
    change: -8.6,
    tone: "oklch(0.72 0.1 30)",
  },
  {
    id: "a4",
    name: "Portfolio",
    institution: "Scalable",
    type: "Investment",
    balance: 62190.83,
    change: 4.7,
    tone: "oklch(0.66 0.08 300)",
  },
];

export const netWorthSeries = [
  { month: "Feb", value: 68200, spend: 3120 },
  { month: "Mar", value: 70140, spend: 2890 },
  { month: "Apr", value: 71980, spend: 3340 },
  { month: "May", value: 74510, spend: 2760 },
  { month: "Jun", value: 76920, spend: 3180 },
  { month: "Jul", value: 79430, spend: 2980 },
  { month: "Aug", value: 83967, spend: 2412 },
];

export const spendingByCategory = [
  { name: "Housing", value: 1180, color: "oklch(0.62 0.09 168)" },
  { name: "Groceries", value: 486, color: "oklch(0.74 0.09 210)" },
  { name: "Dining", value: 312, color: "oklch(0.8 0.09 85)" },
  { name: "Transport", value: 164, color: "oklch(0.72 0.1 30)" },
  { name: "Fun", value: 270, color: "oklch(0.66 0.08 300)" },
];

export const budgets = [
  { name: "Groceries", spent: 486, limit: 600 },
  { name: "Dining out", spent: 312, limit: 300 },
  { name: "Transport", spent: 164, limit: 250 },
  { name: "Shopping", spent: 210, limit: 400 },
];

export type Txn = {
  id: string;
  merchant: string;
  category: string;
  date: string;
  amount: number;
  account: string;
};

export const transactions: Txn[] = [
  { id: "t1", merchant: "Whole Foods", category: "Groceries", date: "Today", amount: -64.2, account: "Everyday" },
  { id: "t2", merchant: "Spotify", category: "Subscriptions", date: "Today", amount: -10.99, account: "Amex Gold" },
  { id: "t3", merchant: "Salary — Northwind", category: "Income", date: "Yesterday", amount: 4200, account: "Everyday" },
  { id: "t4", merchant: "Uber", category: "Transport", date: "Yesterday", amount: -18.4, account: "Amex Gold" },
  { id: "t5", merchant: "Blue Bottle", category: "Dining", date: "Mon", amount: -6.5, account: "Everyday" },
  { id: "t6", merchant: "Vattenfall", category: "Utilities", date: "Mon", amount: -78.0, account: "Everyday" },
  { id: "t7", merchant: "Apple", category: "Shopping", date: "Sun", amount: -249.0, account: "Amex Gold" },
  { id: "t8", merchant: "Rent — Kastanienallee", category: "Housing", date: "Sat", amount: -1180.0, account: "Everyday" },
];

export const recurring = [
  { id: "r1", name: "Rent", cadence: "Monthly · 1st", amount: 1180, next: "in 12 days" },
  { id: "r2", name: "Spotify Family", cadence: "Monthly · 4th", amount: 10.99, next: "in 15 days" },
  { id: "r3", name: "Gym", cadence: "Monthly · 7th", amount: 39, next: "in 18 days" },
  { id: "r4", name: "iCloud 2TB", cadence: "Monthly · 12th", amount: 9.99, next: "in 23 days" },
  { id: "r5", name: "Insurance", cadence: "Quarterly", amount: 148.5, next: "in 31 days" },
];

export const holdings = [
  { name: "VWCE", label: "FTSE All-World", value: 34820, change: 5.2 },
  { name: "AAPL", label: "Apple Inc.", value: 12240, change: 2.8 },
  { name: "BTC", label: "Bitcoin", value: 9840, change: -3.4 },
  { name: "Cash", label: "Money market", value: 5290, change: 0.4 },
];