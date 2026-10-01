// Contribution dates use calendar months; forecasts never move canonical money.
export function goalContributionProjection(goal: { targetMinor: bigint; savedMinor: bigint | null; monthlyMinor: bigint; startsOn: string | null }, today: string) {
  if (goal.savedMinor === null) return { remainingMinor: null, completionDate: null, contributions: null };
  const remainingMinor = goal.targetMinor > goal.savedMinor ? goal.targetMinor - goal.savedMinor : 0n;
  if (remainingMinor === 0n) return { remainingMinor, completionDate: today, contributions: 0n };
  if (goal.monthlyMinor <= 0n || !goal.startsOn) return { remainingMinor, completionDate: null, contributions: null };
  const start = new Date(`${goal.startsOn}T00:00:00Z`), current = new Date(`${today}T00:00:00Z`);
  if (![start, current].every(date => Number.isFinite(date.getTime()))) throw new Error("Invalid contribution date");
  const monthDate = (offset: number) => {
    const date = new Date(start); date.setUTCDate(1); date.setUTCMonth(start.getUTCMonth() + offset);
    date.setUTCDate(Math.min(start.getUTCDate(), new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()));
    return date.toISOString().slice(0, 10);
  };
  let first = Math.max(0, (current.getUTCFullYear() - start.getUTCFullYear()) * 12 + current.getUTCMonth() - start.getUTCMonth());
  if (monthDate(first) < today) first++;
  const contributions = (remainingMinor + goal.monthlyMinor - 1n) / goal.monthlyMinor;
  // ponytail: projections beyond 200 years are unavailable; expand only if real plans need that horizon.
  const completionDate = contributions <= 2400n ? monthDate(first + Number(contributions) - 1) : null;
  return { remainingMinor, completionDate, contributions };
}
