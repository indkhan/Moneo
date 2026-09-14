/** A small, deterministic natural-language filter grammar; unknown terms remain visible search text. */
export function naturalTransactionFilters(query: string, now = new Date()): Record<string, string> {
  let text = query
    .trim()
    .slice(0, 200)
    .replace(/^(show|find|search)( me)?\s+/i, "");
  const filters: Record<string, string> = {};
  const period = /\b(last|this) month\b/i.exec(text);
  if (period) {
    const month = now.getUTCMonth() - (period[1]?.toLowerCase() === "last" ? 1 : 0),
      year = now.getUTCFullYear();
    filters.dateFrom = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
    filters.dateTo = new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10);
    text = text.replace(period[0], "").trim();
  }
  if (text) filters.q = text;
  return filters;
}
