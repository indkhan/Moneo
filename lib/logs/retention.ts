import { calendarDate, calendarDayBoundary } from "@/lib/finance/calendar";
import type { LogRetention } from "./options";

const DAY_MS = 86_400_000;

export function logCutoff(retention: LogRetention, now: Date, timeZone: string): string | null {
  if (retention === "forever") return null;
  const today = calendarDate(now, timeZone);
  const first = new Date(Date.parse(`${today}T00:00:00Z`) - Number(retention) * DAY_MS).toISOString().slice(0, 10);
  return calendarDayBoundary(first, timeZone);
}
