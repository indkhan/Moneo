import { expect, it } from "vitest";
import { consentState } from "./connected-banks";

it("shows the reconnect banner from 7 days before consent ends", () => {
  const now = Date.parse("2026-10-16T12:00:00Z");
  const until = (days: number) => new Date(now + days * 86_400_000).toISOString();
  expect(consentState({ status: "active", valid_until: until(30) }, now)).toBeNull();
  expect(consentState({ status: "active", valid_until: until(6.9) }, now)).toBe("expiring");
  expect(consentState({ status: "active", valid_until: until(-1) }, now)).toBe("expired");
  expect(consentState({ status: "expired", valid_until: until(30) }, now)).toBe("expired");
  expect(consentState({ status: "error", valid_until: null }, now)).toBeNull();
});
