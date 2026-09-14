import { describe, expect, it } from "vitest";
import { isFreshAuthTime, reauthenticateUrl } from "./fresh-auth";

describe("fresh authentication helpers", () => {
  it("accepts only a recent OIDC auth_time claim", () => {
    const now = 10_000;
    expect(isFreshAuthTime(9_701, now)).toBe(true);
    expect(isFreshAuthTime(9_700, now)).toBe(true);
    expect(isFreshAuthTime(9_699, now)).toBe(false);
    expect(isFreshAuthTime(undefined, now)).toBe(false);
    expect(isFreshAuthTime(10_001, now)).toBe(false);
  });

  it("builds a local, prompt=login reauthentication link", () => {
    expect(reauthenticateUrl("/settings?tab=ai")).toBe(
      "/auth/login?prompt=login&max_age=0&returnTo=%2Fsettings%3Ftab%3Dai",
    );
    expect(reauthenticateUrl("https://evil.example")).toBe(
      "/auth/login?prompt=login&max_age=0&returnTo=%2Fsettings",
    );
  });
});
