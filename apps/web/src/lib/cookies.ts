/**
 * Minimal cookie parser for server routes and browser code (no dependencies,
 * no Node APIs — safe to import from client components).
 */
export function cookieValue(header: string | null | undefined, name: string): string | undefined {
  if (!header) {
    return undefined;
  }
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) {
      continue;
    }
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return undefined;
}
