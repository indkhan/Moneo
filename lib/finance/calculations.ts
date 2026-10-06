// Money is always signed integer minor units. Conversion must happen before calling.
export type Balance = { amountMinor: bigint | null; currencyCode: string };

export function netWorth(balances: Balance[], currencyCode: string): bigint | null {
  if (balances.some(balance => balance.amountMinor === null || balance.currencyCode !== currencyCode)) return null;
  return balances.reduce((total, balance) => total + balance.amountMinor!, 0n);
}

export type CashflowTransaction = {
  amountMinor: bigint;
  currencyCode: string;
  status: "posted" | "pending";
  kind: "ordinary" | "transfer" | "refund";
  reviewReasons?: string[];
};

export function summarizeCashflow(transactions: CashflowTransaction[], currencyCode: string) {
  let incomeMinor = 0n;
  let spendingMinor = 0n;
  let excludedReviewRows = 0;
  for (const transaction of transactions) {
    if (transaction.status !== "posted" || transaction.kind === "transfer") continue;
    if (transaction.reviewReasons?.length) { excludedReviewRows++; continue; }
    if (transaction.currencyCode !== currencyCode) return null;
    if (transaction.kind === "refund") spendingMinor -= transaction.amountMinor;
    else if (transaction.amountMinor > 0n) incomeMinor += transaction.amountMinor;
    else spendingMinor -= transaction.amountMinor;
  }
  return { incomeMinor, spendingMinor, netMinor: incomeMinor - spendingMinor,
    ...(excludedReviewRows ? { excludedReviewRows, partial: true as const } : {}) };
}

// Same posted, nontransfer, single-currency rows as the period cashflow.
export function dailySpending(rows: { date: string; amountMinor: bigint; kind: string }[], from: string, to: string) {
  const byDay = new Map<string, bigint>();
  const end = parseDate(to);
  for (let day = parseDate(from); day <= end; day += 86400000) {
    byDay.set(new Date(day).toISOString().slice(0, 10), 0n);
  }
  for (const row of rows) {
    if (!byDay.has(row.date)) continue;
    if (row.kind === "refund" || row.amountMinor < 0n) byDay.set(row.date, byDay.get(row.date)! - row.amountMinor);
  }
  return [...byDay].map(([date, spendingMinor]) => ({ date, spendingMinor: spendingMinor.toString() }));
}

export type ForecastAccount = {
  id: string;
  currencyCode: string;
  balanceMinor: bigint | null;
  // A bank's available balance already includes pending holds. Use it instead of deducting holds again.
  availableMinor?: bigint | null;
  pendingHoldMinor?: bigint;
  reservedMinor?: bigint;
  safetyBufferMinor?: bigint;
  minimumMinor?: bigint;
};

export type ForecastEvent = {
  date: string;
  accountId: string;
  expectedMinor: bigint;
  conservativeMinor?: bigint;
  optimisticMinor?: bigint;
  source?: "confirmed" | "estimated" | "debt" | "scenario";
  name?: string;
};

export type ForecastInput = {
  startDate: string;
  horizonDays: number;
  currencyCode: string;
  accounts: ForecastAccount[];
  events: ForecastEvent[];
  scenarioEvents?: ForecastEvent[];
  missingInputs?: string[];
};

type ForecastDay = {
  date: string;
  expectedMinor: bigint;
  conservativeMinor: bigint;
  optimisticMinor: bigint;
  conservativeByAccount: Record<string, bigint>;
};

type ForecastResult =
  | { status: "unavailable"; missingInputs: string[] }
  | { status: "available"; days: ForecastDay[] };

function parseDate(date: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid date: ${date}`);
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) throw new Error(`Invalid date: ${date}`);
  return timestamp;
}

export function forecastDaily(input: ForecastInput): ForecastResult {
  const start = parseDate(input.startDate);
  if (!Number.isSafeInteger(input.horizonDays) || input.horizonDays < 1 || input.horizonDays > 3660) throw new Error("Invalid forecast horizon");
  const ids = new Set(input.accounts.map(account => account.id));
  if (ids.size !== input.accounts.length) throw new Error("Duplicate account ID");
  const events = [...input.events, ...(input.scenarioEvents ?? [])];
  for (const event of events) {
    parseDate(event.date);
    if (!ids.has(event.accountId)) throw new Error(`Unknown account: ${event.accountId}`);
  }
  const missingInputs = [...(input.missingInputs ?? [])];
  if (!input.accounts.length) missingInputs.push("accounts");
  for (const account of input.accounts) {
    if (account.currencyCode !== input.currencyCode) missingInputs.push(`fx:${account.id}`);
    if (account.availableMinor == null && account.balanceMinor === null) missingInputs.push(`balance:${account.id}`);
    if (account.availableMinor === null) missingInputs.push(`available-balance:${account.id}`);
  }
  if (missingInputs.length) return { status: "unavailable", missingInputs };

  const balances = new Map<string, { expected: bigint; conservative: bigint; optimistic: bigint }>(input.accounts.map(account => {
    const initial = account.availableMinor ?? account.balanceMinor! - (account.pendingHoldMinor ?? 0n);
    return [account.id, { expected: initial, conservative: initial, optimistic: initial }];
  }));
  const days: ForecastDay[] = [];
  for (let offset = 0; offset < input.horizonDays; offset++) {
    const date = new Date(start + offset * 86400000).toISOString().slice(0, 10);
    for (const event of events) {
      if (event.date !== date) continue;
      const balance = balances.get(event.accountId)!;
      balance.expected += event.expectedMinor;
      balance.conservative += event.conservativeMinor ?? event.expectedMinor;
      balance.optimistic += event.optimisticMinor ?? event.expectedMinor;
    }
    const conservativeByAccount = Object.fromEntries([...balances].map(([id, balance]) => [id, balance.conservative]));
    days.push({
      date,
      expectedMinor: [...balances.values()].reduce((sum, balance) => sum + balance.expected, 0n),
      conservativeMinor: [...balances.values()].reduce((sum, balance) => sum + balance.conservative, 0n),
      optimisticMinor: [...balances.values()].reduce((sum, balance) => sum + balance.optimistic, 0n),
      conservativeByAccount,
    });
  }
  return { status: "available", days };
}

export function availableToSpend(input: ForecastInput):
  | { status: "unavailable"; missingInputs: string[] }
  | { status: "available"; amountMinor: bigint; limitingDate: string } {
  const forecast = forecastDaily(input);
  if (forecast.status === "unavailable") return forecast;
  const protectedMinor = input.accounts.reduce((sum, account) => sum + (account.reservedMinor ?? 0n) + (account.safetyBufferMinor ?? 0n) + (account.minimumMinor ?? 0n), 0n);
  const limitingDay = forecast.days.reduce((lowest, day) => day.conservativeMinor < lowest.conservativeMinor ? day : lowest);
  return { status: "available", amountMinor: limitingDay.conservativeMinor - protectedMinor, limitingDate: limitingDay.date };
}

// These amounts are in input.currencyCode, after explicit dated FX conversion by the loader.
export function accountLiquidity(input: ForecastInput) {
  const forecast = forecastDaily(input);
  if (forecast.status === "unavailable") return forecast;
  const aggregate = availableToSpend(input);
  if (aggregate.status === "unavailable") return aggregate;
  const accounts = input.accounts.map(account => {
    const protectedMinor = (account.reservedMinor ?? 0n) + (account.safetyBufferMinor ?? 0n) + (account.minimumMinor ?? 0n);
    const limitingDay = forecast.days.reduce((lowest, day) =>
      day.conservativeByAccount[account.id] < lowest.conservativeByAccount[account.id] ? day : lowest);
    const amountMinor = limitingDay.conservativeByAccount[account.id] - protectedMinor;
    const firstShortfallDate = forecast.days.find(day => day.conservativeByAccount[account.id] < protectedMinor)?.date ?? null;
    return { accountId: account.id, amountMinor, protectedMinor, limitingDate: limitingDay.date,
      shortfallMinor: amountMinor < 0n ? -amountMinor : 0n, firstShortfallDate,
      supportingEvents: [...input.events, ...(input.scenarioEvents ?? [])].filter(event =>
        event.accountId === account.id && event.date >= input.startDate && event.date <= limitingDay.date),
    };
  });
  return { status: "available" as const, currencyCode: input.currencyCode, aggregate, accounts,
    hasShortfall: accounts.some(account => account.shortfallMinor > 0n) };
}

// Paired movements in the forecast currency; never an inferred cross-currency transfer.
export function internalFundingEvents(input: { date: string; fromAccountId: string; toAccountId: string; amountMinor: bigint }): ForecastEvent[] {
  parseDate(input.date);
  if (!input.fromAccountId || !input.toAccountId || input.fromAccountId === input.toAccountId || input.amountMinor <= 0n)
    throw new Error("Invalid internal funding");
  return [
    { date: input.date, accountId: input.fromAccountId, expectedMinor: -input.amountMinor, source: "scenario", name: "Internal funding out" },
    { date: input.date, accountId: input.toAccountId, expectedMinor: input.amountMinor, source: "scenario", name: "Internal funding in" },
  ];
}

export function withInternalFunding(input: ForecastInput, funding: { date: string; currencyCode: string; fromAccountId: string; toAccountId: string; amountMinor: bigint }[]): ForecastInput {
  const end = parseDate(input.startDate) + input.horizonDays * 86400000;
  const events = funding.flatMap(item => {
    if (item.currencyCode !== input.currencyCode) throw new Error("Funding currency must match forecast currency; convert explicitly first");
    if (parseDate(item.date) < parseDate(input.startDate) || parseDate(item.date) >= end) throw new Error("Funding date outside forecast horizon");
    if (!input.accounts.some(account => account.id === item.fromAccountId) || !input.accounts.some(account => account.id === item.toAccountId)) throw new Error("Unknown funding account");
    return internalFundingEvents(item);
  });
  return { ...input, scenarioEvents: [...(input.scenarioEvents ?? []), ...events] };
}

export function serializeAccountLiquidity(result: ReturnType<typeof accountLiquidity>) {
  if (result.status === "unavailable") return result;
  return { ...result, aggregate: { ...result.aggregate, amountMinor: result.aggregate.amountMinor.toString() },
    accounts: result.accounts.map(account => ({ ...account, amountMinor: account.amountMinor.toString(),
      protectedMinor: account.protectedMinor.toString(), shortfallMinor: account.shortfallMinor.toString(),
      supportingEvents: account.supportingEvents.map(event => ({ ...event, expectedMinor: event.expectedMinor.toString(),
        conservativeMinor: (event.conservativeMinor ?? event.expectedMinor).toString(),
        optimisticMinor: (event.optimisticMinor ?? event.expectedMinor).toString() })),
    })),
  };
}
