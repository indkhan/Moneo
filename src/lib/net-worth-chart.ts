export type ChartPoint = { label: string; x: number; y: number };

type BalancePoint = { amountMinor: string };

export function monthOverMonthTenths(points: BalancePoint[]): number | undefined {
  if (points.length < 2) return undefined;
  const previous = BigInt(points.at(-2)!.amountMinor);
  if (previous === 0n) return undefined;
  const latest = BigInt(points.at(-1)!.amountMinor);
  const numerator = (latest - previous) * 1000n;
  const denominator = previous < 0n ? -previous : previous;
  const rounded = (numerator < 0n ? -1n : 1n)
    * ((numerator < 0n ? -numerator : numerator) + denominator / 2n)
    / denominator;
  return Number(rounded);
}

export function chartPoints(values: { label: string; value: number }[]): ChartPoint[] {
  if (!values.length) return [];
  if (values.length === 1) return [{ label: values[0].label, x: 50, y: 46 }];
  const min = Math.min(...values.map((point) => point.value));
  const max = Math.max(...values.map((point) => point.value));
  const range = max - min || 1;
  return values.map((point, index) => ({
    label: point.label,
    x: (index / (values.length - 1)) * 100,
    y: 74 - ((point.value - min) / range) * 56,
  }));
}
