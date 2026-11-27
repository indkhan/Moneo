import { describe, expect, it } from "vitest";
import { logCutoff } from "./retention";

describe("logCutoff", () => {
  it("keeps the owner's whole local days, counted in their time zone", () => {
    const now = new Date("2026-11-27T23:30:00Z");
    expect(logCutoff("14", now, "Europe/Berlin")).toBe("2026-11-13T23:00:00.000Z");
    expect(logCutoff("14", now, "America/Los_Angeles")).toBe("2026-11-13T08:00:00.000Z");
  });

  it("follows daylight saving changes inside the window", () => {
    expect(logCutoff("7", new Date("2026-11-02T12:00:00Z"), "Europe/Berlin")).toBe("2026-10-25T23:00:00.000Z");
    expect(logCutoff("30", new Date("2026-04-15T12:00:00Z"), "Europe/Berlin")).toBe("2026-03-15T23:00:00.000Z");
  });

  it("keeps everything when the owner chose forever", () => {
    expect(logCutoff("forever", new Date("2026-11-27T12:00:00Z"), "UTC")).toBeNull();
  });
});
