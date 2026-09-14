import { describe, expect, it } from "vitest";
import { canManageAiSettings } from "./ai-settings-ownership";

describe("AI settings ownership", () => {
  it("keeps members read-only while allowing owners to manage AI configuration", () => {
    expect(canManageAiSettings({ canManage: true })).toBe(true);
    expect(canManageAiSettings({ canManage: false })).toBe(false);
    expect(canManageAiSettings({})).toBe(false);
  });
});
