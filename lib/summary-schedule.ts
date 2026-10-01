import { calendarDate } from "@/lib/finance/calendar";
import type { WorkspaceSettings } from "@/lib/settings";

export function dueSummaryPeriod(settings: WorkspaceSettings, now = new Date()) {
  if (settings.summary_cadence === "none" || !["accounts", "transactions"].every(scope => settings.ai_data_scopes.includes(scope as "accounts" | "transactions"))) return null;
  const today = calendarDate(now, settings.timezone);
  const day = new Date(`${today}T00:00:00Z`);
  if (settings.summary_cadence === "weekly") day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7);
  else day.setUTCDate(1);
  const periodStart = day.toISOString().slice(0, 10);
  const localTime = new Intl.DateTimeFormat("en-GB", { timeZone: settings.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  if (today === periodStart && localTime < settings.summary_time) return null;
  return { cadence: settings.summary_cadence, periodStart };
}
