import { describe, expect, it } from "vitest";
import { organizeRunState } from "./status";

const now = new Date("2026-11-14T10:00:00Z");
const done = { status: "completed", rerun_trigger: null, organize_after: null };

describe("organizeRunState", () => {
  it("is quiet for a finished run and for no run", () => {
    expect(organizeRunState(done, now)).toEqual({ working: false, queued: false, pausedUntil: null });
    expect(organizeRunState(null, now)).toEqual({ working: false, queued: false, pausedUntil: null });
  });
  it("holds off while a plan limit lasts, and only until it resets", () => {
    expect(organizeRunState({ ...done, organize_after: "2026-11-14T12:00:00Z" }, now).pausedUntil).toBe("2026-11-14T12:00:00Z");
    expect(organizeRunState({ ...done, organize_after: "2026-11-14T09:00:00Z" }, now).pausedUntil).toBeNull();
  });
  it("reports a queued follow-up pass only while a run works", () => {
    expect(organizeRunState({ status: "running", rerun_trigger: "sync", organize_after: null }, now)).toMatchObject({ working: true, queued: true });
    expect(organizeRunState({ ...done, rerun_trigger: "sync" }, now).queued).toBe(false);
  });
});
