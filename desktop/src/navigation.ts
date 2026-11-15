
const LOOPBACK = new Set(["localhost", "127.0.0.1"]);

function parse(url: string) {
  try { return new URL(url); } catch { return null; }
}

export function isAppUrl(url: string, port: number) {
  const parsed = parse(url);
  return parsed?.protocol === "http:" && LOOPBACK.has(parsed.hostname) && parsed.port === String(port);
}

export function isExternalAllowed(url: string, port: number) {
  return parse(url)?.protocol === "https:" || isAppUrl(url, port);
}

export function isBankConsent(url: string) {
  const host = parse(url)?.hostname ?? "";
  return host === "enablebanking.com" || host.endsWith(".enablebanking.com");
}
