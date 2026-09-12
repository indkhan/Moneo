import { describe, expect, it } from "vitest";
import {
  applySecurityHeaders,
  buildSecurityHeaders,
  contentSecurityPolicy,
  permissionsPolicy,
  strictTransportSecurity,
} from "./security-headers";

describe("contentSecurityPolicy", () => {
  it("locks objects/frames/connections to self and blocks framing", () => {
    const csp = contentSecurityPolicy();
    for (const directive of [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "script-src 'self' 'unsafe-inline'",
      "connect-src 'self'",
      "upgrade-insecure-requests",
    ]) {
      expect(csp).toContain(directive);
    }
    // No eval, no plugins, no wildcard sources anywhere.
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toContain("*");
  });
});

describe("buildSecurityHeaders", () => {
  it("sets the full baseline on every response", () => {
    const headers = buildSecurityHeaders({ isProduction: false });
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Referrer-Policy"]).toBe("same-origin");
    expect(headers["Content-Security-Policy"]).toBe(contentSecurityPolicy());
    expect(headers["Permissions-Policy"]).toBe(permissionsPolicy());
  });

  it("sends HSTS in production only — never pin localhost", () => {
    expect(buildSecurityHeaders({ isProduction: false })["Strict-Transport-Security"]).toBeUndefined();
    const prod = buildSecurityHeaders({ isProduction: true });
    expect(prod["Strict-Transport-Security"]).toBe(strictTransportSecurity());
    expect(prod["Strict-Transport-Security"]).toContain("max-age=63072000");
    expect(prod["Strict-Transport-Security"]).toContain("includeSubDomains");
  });
});

describe("permissionsPolicy", () => {
  it("disables sensitive sensors by default", () => {
    const policy = permissionsPolicy();
    for (const feature of ["camera=()", "microphone=()", "geolocation=()", "payment=()"]) {
      expect(policy).toContain(feature);
    }
  });
});

describe("applySecurityHeaders", () => {
  it("copies the baseline onto a live Headers object without dropping existing values", () => {
    const headers = new Headers({ "X-Keep": "yes" });
    applySecurityHeaders(headers, { isProduction: true });
    expect(headers.get("X-Keep")).toBe("yes");
    expect(headers.get("Content-Security-Policy")).toBe(contentSecurityPolicy());
    expect(headers.get("Strict-Transport-Security")).toContain("max-age=");
  });
});
