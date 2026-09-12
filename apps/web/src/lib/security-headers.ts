/**
 * Issue 1.6 — baseline browser hardening headers.
 *
 * Applied to every response by `src/middleware.ts`:
 * - CSP: self-only objects/frames/connections; scripts allow 'unsafe-inline'
 *   because Next.js boots via inline scripts and per-request nonces are an
 *   E20 hardening item. Session theft via inline scripts stays contained:
 *   the session cookie is HttpOnly and no tokens ever reach the DOM.
 *   Inline styles stay allowed because the shell renders `style` attributes
 *   server-side (same E20 revisit).
 * - HSTS: production only — localhost development must never be pinned.
 * - X-Content-Type-Options, Referrer-Policy (same-origin: finance data must
 *   not leak via referrers), Permissions-Policy (sensors off by default).
 */
export function contentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "upgrade-insecure-requests",
  ].join("; ");
}

export function strictTransportSecurity(): string {
  return "max-age=63072000; includeSubDomains; preload";
}

export function permissionsPolicy(): string {
  return ["camera=()", "microphone=()", "geolocation=()", "payment=()", "usb=()", "bluetooth=()"].join(", ");
}

export interface SecurityHeaderOptions {
  /** Set HSTS only for production deployments. */
  isProduction: boolean;
}

/** Header name → value for every response. HSTS included in production only. */
export function buildSecurityHeaders(options: SecurityHeaderOptions): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Security-Policy": contentSecurityPolicy(),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "Permissions-Policy": permissionsPolicy(),
  };
  if (options.isProduction) {
    headers["Strict-Transport-Security"] = strictTransportSecurity();
  }
  return headers;
}

/** Mutating helper used by middleware: copies the baseline onto a response. */
export function applySecurityHeaders(headers: Headers, options: SecurityHeaderOptions): void {
  for (const [name, value] of Object.entries(buildSecurityHeaders(options))) {
    headers.set(name, value);
  }
}
