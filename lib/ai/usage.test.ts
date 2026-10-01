import { describe, expect, it } from "vitest";
import { reportedUsage, usageLabel } from "./usage";

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
