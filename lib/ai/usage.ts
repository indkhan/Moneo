import { z } from "zod";
import { calendarDate } from "@/lib/finance/calendar";

export type ReportedUsage = { model_id: string; input_tokens: number | null; output_tokens: number | null; total_tokens: number | null };

export function reportedUsage(modelId: string, usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number }): ReportedUsage {
  const count = (value: number | undefined) => Number.isSafeInteger(value) && value! >= 0 ? value! : null;
  return { model_id: modelId, input_tokens: count(usage.inputTokens), output_tokens: count(usage.outputTokens), total_tokens: count(usage.totalTokens) };
}

export function usageLabel(usage: ReportedUsage | null) {
  return usage ? `${usage.model_id} · input ${usage.input_tokens ?? "unknown"}, output ${usage.output_tokens ?? "unknown"}, total ${usage.total_tokens ?? "unknown"} tokens · cost unknown` : "Token usage and cost unknown";
}

export const usageWindows = ["7d", "30d", "all"] as const;
export type UsageWindow = (typeof usageWindows)[number];

const DAY_MS = 86_400_000;
const windowDays = { "7d": 7, "30d": 30 } as const;

export function parseUsageWindow(value: unknown): UsageWindow {
  return z.enum(usageWindows).catch("30d").parse(value);
}

export function usageSince(window: UsageWindow, now = new Date()) {
  return window === "all" ? null : new Date(now.getTime() - windowDays[window] * DAY_MS).toISOString();
}

export type UsageLedgerRow = {
  created_at: string; task: string; model_id: string; source: string; status: string;
  input_tokens: number | null; output_tokens: number | null; reasoning_tokens: number | null; cached_input_tokens: number | null;
  audio_seconds: number | string | null; duration_ms: number | null;
};

export type UsageGroup = {
  key: string; requests: number; failures: number; input_tokens: number; output_tokens: number; reasoning_tokens: number;
  audio_seconds: number; average_duration_ms: number | null;
};

export type UsageDay = { day: string; requests: number; input_tokens: number; output_tokens: number };

export type UsageSummary = { totals: UsageGroup & { unreported: number }; byModel: UsageGroup[]; byTask: UsageGroup[]; bySource: UsageGroup[]; byDay: UsageDay[] };

type Tally = UsageGroup & { timed: number; durationTotal: number };

const emptyTally = (key: string): Tally => ({ key, requests: 0, failures: 0, input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, audio_seconds: 0, average_duration_ms: null, timed: 0, durationTotal: 0 });

function add(tally: Tally, row: UsageLedgerRow) {
  tally.requests++;
  if (row.status === "failed") tally.failures++;
  tally.input_tokens += row.input_tokens ?? 0;
  tally.output_tokens += row.output_tokens ?? 0;
  tally.reasoning_tokens += row.reasoning_tokens ?? 0;
  tally.audio_seconds += Number(row.audio_seconds ?? 0);
  if (row.duration_ms !== null) { tally.timed++; tally.durationTotal += row.duration_ms; }
}

const finished = ({ timed, durationTotal, ...group }: Tally): UsageGroup => ({ ...group, average_duration_ms: timed ? Math.round(durationTotal / timed) : null });
const tokens = (group: UsageGroup) => group.input_tokens + group.output_tokens;

function grouped(rows: UsageLedgerRow[], keyOf: (row: UsageLedgerRow) => string) {
  const groups = new Map<string, Tally>();
  for (const row of rows) {
    const key = keyOf(row);
    const tally = groups.get(key) ?? emptyTally(key);
    add(tally, row);
    groups.set(key, tally);
  }
  return [...groups.values()].map(finished).sort((a, b) => tokens(b) - tokens(a) || b.requests - a.requests || a.key.localeCompare(b.key));
}

export function summarizeUsage(rows: UsageLedgerRow[], timeZone: string): UsageSummary {
  const total = emptyTally("all");
  let unreported = 0;
  for (const row of rows) {
    add(total, row);
    if (row.status === "succeeded" && row.audio_seconds === null && (row.input_tokens === null || row.output_tokens === null)) unreported++;
  }
  const days = new Map<string, UsageDay>();
  for (const row of rows) {
    const day = calendarDate(row.created_at, timeZone);
    const entry = days.get(day) ?? { day, requests: 0, input_tokens: 0, output_tokens: 0 };
    entry.requests++;
    entry.input_tokens += row.input_tokens ?? 0;
    entry.output_tokens += row.output_tokens ?? 0;
    days.set(day, entry);
  }
  return {
    totals: { ...finished(total), unreported },
    byModel: grouped(rows, row => row.model_id), byTask: grouped(rows, row => row.task), bySource: grouped(rows, row => row.source),
    byDay: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)),
  };
}
