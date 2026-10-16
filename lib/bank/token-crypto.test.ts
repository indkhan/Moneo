import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decryptToken, encryptToken } from "./token-crypto";

describe("bank token encryption", () => {
  beforeEach(() => vi.stubEnv("BANK_TOKEN_ENCRYPTION_KEY", randomBytes(32).toString("base64")));
  afterEach(() => vi.unstubAllEnvs());

  it("round-trips and never stores the plain session id", () => {
    const sealed = encryptToken("session-123", "conn-a");
    expect(sealed).not.toContain("session-123");
    expect(encryptToken("session-123", "conn-a")).not.toBe(sealed);
    expect(decryptToken(sealed, "conn-a")).toBe("session-123");
  });

  it("rejects tampering, another connection and a wrong key", () => {
    const sealed = encryptToken("session-123", "conn-a");
    expect(() => decryptToken(sealed, "conn-b")).toThrow();
    const bytes = Buffer.from(sealed.slice(3), "base64");
    bytes[bytes.length - 1] ^= 1;
    expect(() => decryptToken(`v1:${bytes.toString("base64")}`, "conn-a")).toThrow();
    vi.stubEnv("BANK_TOKEN_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    expect(() => decryptToken(sealed, "conn-a")).toThrow();
  });

  it("requires a 32-byte key", () => {
    vi.stubEnv("BANK_TOKEN_ENCRYPTION_KEY", randomBytes(16).toString("base64"));
    expect(() => encryptToken("x", "conn-a")).toThrow(/32 bytes/);
  });
});
