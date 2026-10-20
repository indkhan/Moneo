import { formatMoney } from "@/lib/finance/format";

const INTERNAL_KEYS = new Set(["calculationEvidence", "evidenceReceipts", "workspace_id", "workspaceId"]);
const LIMIT = 2000;

/** The short, user-facing preview of a tool result streamed to the chat; internal fields are left out. */
export function toolOutputPreview(output: unknown): string {
  const shown = JSON.stringify(output, (key, value) => INTERNAL_KEYS.has(key) ? undefined : value, 2) ?? "";
  return shown.length > LIMIT ? `${shown.slice(0, LIMIT)}\n… (truncated)` : shown;
}

/** Owned entity names by id, used to label ids in tool output. */
export type EntityNames = Partial<Record<"account" | "category" | "merchant", Map<string, string>>>;

const CURRENCY = /^[A-Z]{3}$/;
const INTEGER = /^-?\d{1,19}$/;
const ID_KEY = /^(account|category|merchant)(?:_id|Id)?$/;

function money(value: unknown, currency: unknown): string | null {
  if (typeof currency !== "string" || !CURRENCY.test(currency)) return null;
  if (typeof value === "string" ? !INTEGER.test(value) : !Number.isSafeInteger(value)) return null;
  try { return formatMoney(value as string | number, currency); } catch { return null; }
}

/**
 * The tool result as the model reads it: internal evidence is dropped, minor-unit amounts gain a
 * formatted sibling (`amount_minor` → `amount_formatted`, `spendingMinor` → `spendingFormatted`) and
 * account/category/merchant ids gain their owned names. Exact minor units and currencies are kept.
 */
export function readableToolOutput(output: unknown, names: EntityNames = {}): unknown {
  function walk(value: unknown, inherited?: string): unknown {
    if (Array.isArray(value)) return value.map(item => walk(item, inherited));
    if (!value || typeof value !== "object") return value;
    const row = value as Record<string, unknown>;
    const currency = [row.currency_code, row.currencyCode, row.currency, inherited].find(item => typeof item === "string" && CURRENCY.test(item)) as string | undefined;
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(row)) {
      if (INTERNAL_KEYS.has(key)) continue;
      result[key] = walk(child, CURRENCY.test(key) ? key : currency);
      const minor = /^(.*?)(_minor|Minor)$/.exec(key);
      if (minor) {
        // Per-currency maps such as { EUR: "1200" } are formatted per key.
        const formatted = child && typeof child === "object" && !Array.isArray(child)
          ? Object.fromEntries(Object.entries(child).flatMap(([code, amount]) => { const shown = money(amount, code); return shown ? [[code, shown]] : []; }))
          : money(child, currency);
        if (formatted && (typeof formatted === "string" || Object.keys(formatted).length)) result[`${minor[1]}${minor[2] === "Minor" ? "Formatted" : "_formatted"}`] = formatted;
      } else if ((key === "netWorth" || key === "accountBalanceTotals") && child && typeof child === "object") {
        result[`${key}Formatted`] = Object.fromEntries(Object.entries(child).flatMap(([code, amount]) => { const shown = money(amount, code); return shown ? [[code, shown]] : []; }));
      }
      const id = ID_KEY.exec(key);
      if (id && typeof child === "string") {
        const name = names[id[1] as keyof EntityNames]?.get(child);
        if (name) result[key.includes("_") ? `${id[1]}_name` : `${id[1]}Name`] = name;
      }
    }
    return result;
  }
  return walk(output);
}
