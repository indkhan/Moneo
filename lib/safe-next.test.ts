import { expect, it } from "vitest";
import { safeNextPath } from "./safe-next";

it("keeps same-site paths with their query", () => {
  expect(safeNextPath("/money/accounts?account=1")).toBe("/money/accounts?account=1");
});

it.each([null, undefined, "", "settings", "//evil.com", "/\\evil.com", "/a\\b", "https://evil.com"])("falls back to Home for %s", next => {
  expect(safeNextPath(next)).toBe("/");
});
