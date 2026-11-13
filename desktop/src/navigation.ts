// Which addresses the app window may show, and which go to the system browser instead.
// Pure functions, so the rules are testable without Electron.

const LOOPBACK = new Set(["localhost", "127.0.0.1"]);

function parse(url: string) {
  try { return new URL(url); } catch { return null; }
}

/** Moneo's own server on this computer: the only pages the app window loads. */
export function isAppUrl(url: string, port: number) {
  const parsed = parse(url);
  return parsed?.protocol === "http:" && LOOPBACK.has(parsed.hostname) && parsed.port === String(port);
}

/** What may open in the system browser: https anywhere (sign-ins, banks), or Moneo itself. */
export function isExternalAllowed(url: string, port: number) {
  return parse(url)?.protocol === "https:" || isAppUrl(url, port);
}

/** Enable Banking's consent pages; the bank sends the browser back to https://localhost:3443. */
export function isBankConsent(url: string) {
  const host = parse(url)?.hostname ?? "";
  return host === "enablebanking.com" || host.endsWith(".enablebanking.com");
}
