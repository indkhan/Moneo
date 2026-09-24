// E06-S01 weekly variable-spend baseline (pure, no DB, BigInt-only).
// R1 uses the median of complete weekly variable-spend buckets and requires
// at least `need` complete weeks (default 8, architecture section 227).
// Partial-coverage weeks are never complete: the caller marks them, and they
// are excluded here even when carrying large amounts.

export type BaselineWeek = {
  start: string;
  complete: boolean;
  spendMinor: bigint;
};

export type BaselineResult = {
  status: "ok" | "insufficient";
  have: number;
  need: number;
  medianMinor: bigint | null;
};

function checkNeed(need: number): void {
  if (!Number.isInteger(need) || need < 1 || need > 52) throw new Error("invalid_need");
}

/**
 * Median of complete weeks only. Odd counts take the middle value; even
 * counts take the exact mean of the two middles, with an odd sum rounded
 * to even (banker's) so the result stays an exact minor-unit integer.
 * Fewer than `need` complete weeks yields `insufficient` with a null
 * median — never a silent zero.
 */
export function buildWeeklyBaseline(weeks: BaselineWeek[], need: number): BaselineResult {
  checkNeed(need);
  const complete = weeks.filter((w) => w.complete).map((w) => w.spendMinor);
  complete.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (complete.length < need) {
    return { status: "insufficient", have: complete.length, need, medianMinor: null };
  }
  const mid = Math.floor(complete.length / 2);
  let median: bigint;
  if (complete.length % 2 === 1) {
    median = complete[mid]!;
  } else {
    median = roundHalfEvenDiv(complete[mid - 1]! + complete[mid]!, 2n);
  }
  return { status: "ok", have: complete.length, need, medianMinor: median };
}

/** Integer division with round-half-even (banker's), sign-aware. */
function roundHalfEvenDiv(num: bigint, den: bigint): bigint {
  if (den <= 0n) throw new Error("invalid_divisor");
  const negative = num < 0n;
  const abs = negative ? -num : num;
  const q = abs / den;
  const r = abs % den;
  const twice = r * 2n;
  let rounded = q;
  if (twice > den) rounded = q + 1n;
  else if (twice === den && q % 2n !== 0n) rounded = q + 1n;
  return negative ? -rounded : rounded;
}
