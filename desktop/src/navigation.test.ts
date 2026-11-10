import { describe, expect, it } from "vitest";
import { isAppUrl, isExternalAllowed } from "./navigation";

// The app window has the owner's session and microphone access; a lookalike host or another local
// server must never load inside it.
describe("desktop navigation rules", () => {
  it("keeps only Moneo's own loopback port in the window", () => {
    expect(isAppUrl("http://localhost:47300/settings", 47300)).toBe(true);
    expect(isAppUrl("http://127.0.0.1:47300/api/ai/chatgpt/callback?code=x", 47300)).toBe(true);
    expect(isAppUrl("http://localhost:3000/", 47300)).toBe(false);
    expect(isAppUrl("http://localhost.evil.example:47300/", 47300)).toBe(false);
    expect(isAppUrl("https://localhost:47300/", 47300)).toBe(false);
    expect(isAppUrl("file:///etc/passwd", 47300)).toBe(false);
  });

  it("sends only https or Moneo itself to the system browser", () => {
    expect(isExternalAllowed("https://auth.openai.com/oauth/authorize", 47300)).toBe(true);
    expect(isExternalAllowed("http://localhost:47300/", 47300)).toBe(true);
    expect(isExternalAllowed("http://example.com/", 47300)).toBe(false);
    expect(isExternalAllowed("file:///C:/Windows/System32/calc.exe", 47300)).toBe(false);
    expect(isExternalAllowed("javascript:alert(1)", 47300)).toBe(false);
  });
});
