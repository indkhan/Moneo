import { expect, it } from "vitest";
import { BANK_REDIRECT_URL, forwardTarget } from "./return-listener";

it("forwards the bank's reply to Moneo's own callback with its query intact", () => {
  expect(forwardTarget("/api/bank/callback?state=abc&code=xyz", "http://localhost:3000"))
    .toBe("http://localhost:3000/api/bank/callback?state=abc&code=xyz");
  expect(BANK_REDIRECT_URL).toBe("https://localhost:3443/api/bank/callback");
});

it("forwards nothing else, and only ever to Moneo itself", () => {
  expect(forwardTarget("/", "http://localhost:3000")).toBeNull();
  expect(forwardTarget("/settings", "http://localhost:3000")).toBeNull();
  expect(new URL(forwardTarget("//evil.example/api/bank/callback?code=1", "http://localhost:3000")!).origin).toBe("http://localhost:3000");
});
