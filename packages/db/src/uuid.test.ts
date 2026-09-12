import { describe, expect, it } from "vitest";
import { assertUuid, isUuidV7, randomUUID, uuidv7 } from "./uuid.js";

describe("uuidv7 generator", () => {
  it("emits canonical 8-4-4-4-12 lowercase hex with version nibble 7", () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(isUuidV7(id)).toBe(true);
  });

  it("sets the RFC 9562 variant bits (10xx) in the clock_seq_hi field", () => {
    for (let i = 0; i < 25; i += 1) {
      const variant = uuidv7().split("-")[3]?.[0];
      expect(["8", "9", "a", "b"]).toContain(variant);
    }
  });

  it("encodes the timestamp in the first 48 bits, so ids sort by creation time", () => {
    const first = uuidv7(1_700_000_000_000);
    const second = uuidv7(1_700_000_000_001);
    expect(first < second).toBe(true);
    expect(Number.parseInt(first.replaceAll("-", "").slice(0, 12), 16)).toBe(1_700_000_000_000);
    expect(isUuidV7(first)).toBe(true);
  });

  it("accepts the Unix epoch and the maximum 48-bit timestamp", () => {
    expect(isUuidV7(uuidv7(0))).toBe(true);
    expect(isUuidV7(uuidv7(0xffffffffffff))).toBe(true);
  });

  it("rejects negative, fractional, NaN and overflowing timestamps", () => {
    expect(() => uuidv7(-1)).toThrow(RangeError);
    expect(() => uuidv7(1.5)).toThrow(RangeError);
    expect(() => uuidv7(Number.NaN)).toThrow(RangeError);
    expect(() => uuidv7(0x1_0000_0000_0000)).toThrow(RangeError);
  });

  it("generates unique ids across a large batch", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1_000; i += 1) {
      seen.add(uuidv7());
    }
    expect(seen.size).toBe(1_000);
  });

  it("isUuidV7 rejects v4 ids, wrong versions, bad hyphenation and garbage", () => {
    expect(isUuidV7(randomUUID())).toBe(false); // v4
    expect(isUuidV7("11111111-1111-4111-8111-111111111111")).toBe(false); // version 4
    expect(isUuidV7(uuidv7().replaceAll("-", ""))).toBe(false); // no hyphens
    expect(isUuidV7("not-a-uuid")).toBe(false);
    expect(isUuidV7("")).toBe(false);
    expect(isUuidV7("11111111-1111-7111-7111-111111111111")).toBe(false); // bad variant
    // Uppercase hex in canonical positions is still a v7 id.
    expect(isUuidV7(uuidv7().toUpperCase())).toBe(true);
  });
});

describe("assertUuid guard", () => {
  it("passes through well-formed ids unchanged", () => {
    const id = uuidv7();
    expect(assertUuid(id)).toBe(id);
    expect(assertUuid(id, "workspaceId")).toBe(id);
  });

  it("rejects SQL injection attempts instead of interpolating them", () => {
    const evil = `11111111-1111-7111-8111-111111111111'; DROP TABLE users; --`;
    expect(() => assertUuid(evil, "workspaceId")).toThrow(/Invalid workspaceId/);
    expect(() => assertUuid("'; SET app.current_workspace='x", "workspaceId")).toThrow();
  });

  it("rejects empty, truncated and non-hex input with a labelled error", () => {
    expect(() => assertUuid("", "workspaceId")).toThrow("Invalid workspaceId: not a UUID");
    expect(() => assertUuid("1234", "workspaceId")).toThrow("Invalid workspaceId");
    expect(() => assertUuid("zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz")).toThrow();
  });
});
