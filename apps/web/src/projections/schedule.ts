// E06-S01 deterministic schedule expansion (pure, no DB, no floats).
// All date math uses the UTC calendar. Month-end recurrence clamps to the
// final day of the month; leap-day yearly recurrence uses February's final
// day in non-leap years (architecture section 227).

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function checkDate(value: string): { year: number; month: number; day: number } {
  if (!DATE_RE.test(value)) throw new Error("invalid_date");
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) {
    throw new Error("invalid_date");
  }
  return { year, month, day };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function iso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${pad(month)}-${pad(day)}`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function checkDayOfMonth(day: number): void {
  if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error("invalid_day");
}

/** Monthly dates on the given day-of-month, clamped to each month's length. */
export function expandMonthly(dayOfMonth: number, from: string, to: string): string[] {
  checkDayOfMonth(dayOfMonth);
  const start = checkDate(from);
  const end = checkDate(to);
  if (from > to) throw new Error("invalid_range");
  const out: string[] = [];
  let year = start.year;
  let month = start.month;
  // Skip months before the start month only; within the start month, the
  // clamped date counts when it falls on/after the start day.
  for (;;) {
    const last = daysInMonth(year, month);
    const day = Math.min(dayOfMonth, last);
    if (year === start.year && month === start.month && day < start.day) {
      // falls before the window start: emit nothing this month
    } else {
      const current = iso(year, month, day);
      if (current > to) break;
      if (current >= from) out.push(current);
    }
    if (year === end.year && month === end.month) break;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
    if (`${String(year).padStart(4, "0")}-${pad(month)}-01` > to) break;
  }
  return out;
}

/** Yearly Feb-29 recurrence between two years (inclusive). */
export function expandLeapDay(startDate: string, fromYear: number, toYear: number): string[] {
  const start = checkDate(startDate);
  if (start.month !== 2 || start.day !== 29) throw new Error("not_leap_day");
  if (!Number.isInteger(fromYear) || !Number.isInteger(toYear) || fromYear > toYear) throw new Error("invalid_range");
  const out: string[] = [];
  for (let year = fromYear; year <= toYear; year++) {
    out.push(daysInMonth(year, 2) === 29 ? iso(year, 2, 29) : iso(year, 2, 28));
  }
  return out;
}

/**
 * Split an exact minor-unit total across N days. The absolute value is
 * divided; the whole-unit remainder goes +1 to the earliest days and the
 * original sign is reapplied, so the parts always sum back to the total
 * (BigInt-only; no rounding policy choice is hidden).
 */
export function distributeDaily(totalMinor: bigint, days: number): bigint[] {
  if (!Number.isInteger(days) || days < 1 || days > 366) throw new Error("invalid_days");
  const negative = totalMinor < 0n;
  const abs = negative ? -totalMinor : totalMinor;
  const per = abs / BigInt(days);
  const rem = abs % BigInt(days);
  const out: bigint[] = [];
  for (let i = 0; i < days; i++) {
    const part = per + (BigInt(i) < rem ? 1n : 0n);
    out.push(negative ? -part : part);
  }
  return out;
}
