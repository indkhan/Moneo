import { expect, it } from "vitest";
import { nextBackgroundSync } from "./sync-state";

it("plans the next background bank sync 20 hours after the last attempt, never before the bank allows it", () => {
  const now = Date.parse("2026-11-27T12:00:00Z");
  expect(nextBackgroundSync([{ last_attempted_at: "2026-11-27T08:00:00Z", next_allowed_at: null }], now)).toBe("2026-11-28T04:00:00.000Z");
  expect(nextBackgroundSync([{ last_attempted_at: "2026-11-27T08:00:00Z", next_allowed_at: "2026-11-28T09:00:00Z" }], now)).toBe("2026-11-28T09:00:00.000Z");
  expect(nextBackgroundSync([{ last_attempted_at: "2026-11-27T08:00:00Z", next_allowed_at: null }, { last_attempted_at: null, next_allowed_at: null }], now)).toBe("2026-11-27T12:00:00.000Z");
  expect(nextBackgroundSync([], now)).toBeNull();
});
