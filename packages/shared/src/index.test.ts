import { describe, expect, it } from "vitest";
import { fromMinorUnits, toMinorUnits } from "./money.js";
import { loadEnv } from "./env.js";

describe("money", () => {
  it("converts EUR major to minor units exactly", () => {
    expect(toMinorUnits("12.34", 2)).toBe(1234n);
  });

  it("supports zero-decimal currencies (JPY)", () => {
    expect(toMinorUnits("1500", 0)).toBe(1500n);
    expect(fromMinorUnits(1500n, 0)).toBe("1500");
  });

  it("supports three-decimal currencies (BHD)", () => {
    expect(toMinorUnits("1.234", 3)).toBe(1234n);
    expect(fromMinorUnits(1234n, 3)).toBe("1.234");
  });

  it("rejects precision beyond the currency exponent", () => {
    expect(() => toMinorUnits("1.234", 2)).toThrow();
  });

  it("rejects non-numeric input instead of parseFloat coercion", () => {
    expect(() => toMinorUnits("abc", 2)).toThrow();
  });
});

describe("env", () => {
  it("applies safe defaults for local development", () => {
    const env = loadEnv({});
    expect(env.APP_ENV).toBe("development");
    expect(env.REDIS_URL).toContain("redis://");
  });

  it("keeps a dedicated outbox dispatcher database URL", () => {
    const outboxUrl = "postgres://dispatcher:secret@localhost:5432/moneo";
    expect(loadEnv({ OUTBOX_DATABASE_URL: outboxUrl }).OUTBOX_DATABASE_URL).toBe(outboxUrl);
  });

  it("keeps the explicit AI credential KMS key identifier", () => {
    const keyId = "alias/finance-staging-user-credentials";
    expect(loadEnv({ AI_CREDENTIAL_KMS_KEY_ID: keyId }).AI_CREDENTIAL_KMS_KEY_ID).toBe(keyId);
  });
});
