import { describe, expect, it } from "vitest";
import { parseUsageWindow, reportedUsage, summarizeUsage, usageLabel, usageSince, type UsageLedgerRow } from "./usage";

describe("provider usage", () => {
  it("preserves reported zero tokens and labels unavailable totals and costs", () => {
    const usage = reportedUsage("free/model", { inputTokens: 0, outputTokens: 12 });
    expect(usage).toEqual({ model_id: "free/model", input_tokens: 0, output_tokens: 12, total_tokens: null });
    expect(usageLabel(usage)).toBe("free/model · input 0, output 12, total unknown tokens · cost unknown");
    expect(usageLabel(null)).toBe("Token usage and cost unknown");
  });
  it("does not infer or round invalid provider counts", () => {
    expect(reportedUsage("free/model", { inputTokens: -1, outputTokens: 1.5, totalTokens: Number.MAX_SAFE_INTEGER + 1 })).toMatchObject({ input_tokens: null, output_tokens: null, total_tokens: null });
  });
});

describe("AI usage summary", () => {
  const row = (created_at: string, model_id: string, task: string, source: string, input: number | null, output: number | null, extra: Partial<UsageLedgerRow> = {}): UsageLedgerRow =>
    ({ created_at, model_id, task, source, status: "succeeded", input_tokens: input, output_tokens: output, reasoning_tokens: null, cached_input_tokens: null, audio_seconds: null, duration_ms: null, ...extra });
  it("totals tokens, requests, failures and average time per model, task and source, largest first", () => {
    const summary = summarizeUsage([
      row("2026-11-20T10:00:00Z", "small/model", "titles", "openrouter", 10, 5, { duration_ms: 100 }),
      row("2026-11-20T11:00:00Z", "big/model", "chat", "chatgpt", 500, 100, { duration_ms: 300, reasoning_tokens: 40 }),
      row("2026-11-21T09:00:00Z", "big/model", "chat", "chatgpt", 20, 0),
      row("2026-11-21T09:30:00Z", "big/model", "organize", "chatgpt", null, null, { status: "failed", duration_ms: 50 }),
      row("2026-11-21T09:40:00Z", "gpt-4o-transcribe", "speech_to_text", "openai", null, null, { audio_seconds: "2.500" }),
    ], "UTC");
    expect(summary.byModel.map(group => [group.key, group.requests, group.failures, group.input_tokens, group.output_tokens, group.average_duration_ms]))
      .toEqual([["big/model", 3, 1, 520, 100, 175], ["small/model", 1, 0, 10, 5, 100], ["gpt-4o-transcribe", 1, 0, 0, 0, null]]);
    expect(summary.byTask.map(group => [group.key, group.input_tokens + group.output_tokens])).toEqual([["chat", 620], ["titles", 15], ["organize", 0], ["speech_to_text", 0]]);
    expect(summary.bySource.map(group => [group.key, group.requests])).toEqual([["chatgpt", 3], ["openrouter", 1], ["openai", 1]]);
    expect(summary.totals).toMatchObject({ requests: 5, failures: 1, input_tokens: 530, output_tokens: 105, reasoning_tokens: 40, audio_seconds: 2.5, average_duration_ms: 150, unreported: 0 });
  });
  it("counts a successful call without token counts as unreported, and never as zero tokens", () => {
    expect(summarizeUsage([row("2026-11-20T10:00:00Z", "m", "chat", "unknown", 12, null)], "UTC").totals).toMatchObject({ unreported: 1, input_tokens: 12, output_tokens: 0 });
  });
  it("puts each call on the owner's calendar day from Settings", () => {
    const rows = [row("2026-11-20T23:30:00Z", "m", "chat", "openai", 1, 1), row("2026-11-21T00:30:00Z", "m", "chat", "openai", 2, 2)];
    expect(summarizeUsage(rows, "UTC").byDay.map(day => [day.day, day.requests])).toEqual([["2026-11-20", 1], ["2026-11-21", 1]]);
    expect(summarizeUsage(rows, "Europe/Berlin").byDay).toEqual([{ day: "2026-11-21", requests: 2, input_tokens: 3, output_tokens: 3 }]);
    expect(summarizeUsage(rows, "America/New_York").byDay.map(day => [day.day, day.requests])).toEqual([["2026-11-20", 2]]);
  });
  it("maps the period to a start time and falls back to 30 days for unknown values", () => {
    const now = new Date("2026-10-26T12:00:00Z");
    expect(usageSince("7d", now)).toBe("2026-10-19T12:00:00.000Z");
    expect(usageSince("30d", now)).toBe("2026-09-26T12:00:00.000Z");
    expect(usageSince("all", now)).toBeNull();
    expect(parseUsageWindow("7d")).toBe("7d");
    expect(parseUsageWindow("forever")).toBe("30d");
    expect(parseUsageWindow(undefined)).toBe("30d");
  });
});
