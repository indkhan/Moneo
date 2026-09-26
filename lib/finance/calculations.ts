// Shared, exact financial calculations in integer cents.
// AI narrates; this module computes. Both UI and workflows import from here.

export function sumCents(amounts: number[]): number {
  return amounts.reduce((a, b) => a + b, 0);
}

export function netWorthCents(balances: number[]): number {
  return sumCents(balances);
}

/** Available-to-spend = balances − reserved − upcoming bills. All in cents. */
export function availableToSpendCents(args: {
  balances: number[];
  reserved: number[];
  upcoming: number[];
}): number {
  return sumCents(args.balances) - sumCents(args.reserved) - sumCents(args.upcoming);
}

export function formatCents(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}
