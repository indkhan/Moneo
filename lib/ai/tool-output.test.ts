import { describe, expect, it } from "vitest";
import { toolOutputPreview } from "./tool-output";

describe("toolOutputPreview", () => {
  it("leaves out internal fields", () => {
    expect(JSON.parse(toolOutputPreview({ total: "100", calculationEvidence: { a: 1 }, nested: { workspace_id: "w", name: "x" } })))
      .toEqual({ total: "100", nested: { name: "x" } });
  });
  it("caps long output", () => {
    const shown = toolOutputPreview({ rows: "x".repeat(5000) });
    expect(shown.length).toBeLessThan(2100);
    expect(shown.endsWith("… (truncated)")).toBe(true);
  });
  it("handles undefined", () => { expect(toolOutputPreview(undefined)).toBe(""); });
});
