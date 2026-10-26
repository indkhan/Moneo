import { describe, expect, it } from "vitest";
import { parseUsageWindow, reportedUsage, usageByModel, usageLabel, usageSince } from "./usage";

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
  it("totals reported tokens per model, largest first, and counts requests without counts as unreported", () => {
    const { models, unreported } = usageByModel([
      { usage: { model_id: "small/model", input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
      { usage: { model_id: "big/model", input_tokens: 500, output_tokens: 100, total_tokens: 600 } },
      { usage: { model_id: "big/model", input_tokens: 20, output_tokens: 0, total_tokens: 20 } },
      { usage: { model_id: "big/model", input_tokens: null, output_tokens: 7, total_tokens: null } },
      { usage: null },
      { usage: { model_id: "", input_tokens: 1, output_tokens: 1 } },
    ]);
    expect(models).toEqual([
      { model_id: "big/model", requests: 3, input_tokens: 520, output_tokens: 107 },
      { model_id: "small/model", requests: 1, input_tokens: 10, output_tokens: 5 },
    ]);
    expect(unreported).toBe(3);
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
