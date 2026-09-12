import { describe, expect, it } from "vitest";
import { CommandError } from "./commands.js";
import { assertVersionMatch, initialVersion, nextVersion } from "./versions.js";

/** Issue 5.2 — optimistic version helpers shared by correction/undo commands. */
describe("optimistic entity versions", () => {
  it("starts new rows at 1 and increments by exactly one", () => {
    expect(initialVersion()).toBe(1);
    expect(nextVersion(1)).toBe(2);
    expect(nextVersion(41)).toBe(42);
  });

  it("accepts a matching expectation and an absent guard", () => {
    expect(() => {
      assertVersionMatch(3, 3, "transaction");
    }).not.toThrow();
    expect(() => {
      assertVersionMatch(3, null, "transaction");
    }).not.toThrow();
    expect(() => {
      assertVersionMatch(3, undefined, "transaction");
    }).not.toThrow();
  });

  it("rejects a stale expectation with VERSION_CONFLICT", () => {
    try {
      assertVersionMatch(4, 3, "transaction");
      expect.unreachable("stale version must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CommandError);
      expect((error as CommandError).code).toBe("VERSION_CONFLICT");
      expect((error as CommandError).details).toMatchObject({
        expectedVersion: 3,
        currentVersion: 4,
      });
    }
  });
});
