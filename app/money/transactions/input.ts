import { z } from "zod";
import { minorDigits } from "@/lib/finance/fx";

export function parseManualAmount(value: string, currency: string): bigint {
  const digits = minorDigits(currency);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(z.string().trim().max(30).parse(value));
  if (!match || (match[3]?.length ?? 0) > digits) throw new Error(`Enter a decimal amount with up to ${digits} decimal places, without grouping separators`);
  const minor = (BigInt(match[2]) * 10n ** BigInt(digits) + BigInt((match[3] ?? "").padEnd(digits, "0") || "0")) * (match[1] ? -1n : 1n);
  if (minor < -9223372036854775808n || minor > 9223372036854775807n) throw new Error("Amount exceeds supported integer range");
  return minor;
}

const magnitude = (value: string, currency: string) => { const minor = parseManualAmount(value, currency); return minor < 0n ? -minor : minor; };

/** A positive amount plus a direction, as people say it, to the signed minor units the ledger stores. */
export function directedAmount(value: string, direction: string, currency: string): bigint {
  const minor = parseManualAmount(value, currency);
  if (minor < 0n) throw new Error("Enter the amount without a minus sign, and choose Money out or Money in");
  return direction === "out" ? -minor : minor;
}

/** The ledger's signed min/max for a "from 10 to 50" typed with a direction. Without a direction the amounts stay signed as typed. */
export function amountBounds(direction: string, from: string, to: string, currency: string) {
  if (direction !== "outflow" && direction !== "income") return { minAmount: from ? parseManualAmount(from, currency) : undefined, maxAmount: to ? parseManualAmount(to, currency) : undefined };
  const low = from ? magnitude(from, currency) : undefined, high = to ? magnitude(to, currency) : undefined;
  return direction === "income" ? { minAmount: low, maxAmount: high } : { minAmount: high === undefined ? undefined : -high, maxAmount: low === undefined ? undefined : -low };
}

/** The reverse of amountBounds, to show a filter back as it was typed. */
export function shownBounds(direction: string | undefined, minAmount?: string, maxAmount?: string) {
  if (direction !== "outflow") return { from: minAmount, to: maxAmount };
  const positive = (minor?: string) => minor === undefined ? undefined : minor.replace(/^-/, "");
  return { from: positive(maxAmount), to: positive(minAmount) };
}

export const versionedRows = z.array(z.object({ id: z.uuid(), version: z.number().int().min(0).max(2147483647) }).strict()).min(1).max(50)
  .refine(rows => new Set(rows.map(row => row.id)).size === rows.length, "Select each transaction once");

export function bulkInput(value: unknown) {
  const input = z.object({ rows: versionedRows, requestId: z.uuid(), confirmed: z.literal("true"), mode: z.enum(["category", "merchant", "tags", "event"]), value: z.string().max(1000) }).parse(value);
  let patch: Record<string, unknown>;
  if (input.mode === "category" || input.mode === "merchant") patch = { [input.mode === "merchant" ? "merchant_id" : "category_id"]: input.value ? z.uuid().parse(input.value) : null };
  else if (input.mode === "event") patch = { event_name: z.string().trim().max(120).parse(input.value) || null };
  else patch = { tags: z.array(z.string().min(1).max(40)).max(20).parse([...new Set(input.value.split(",").map(tag => tag.trim().toLowerCase()).filter(Boolean))].sort()) };
  return { rows: input.rows, requestId: input.requestId, patch };
}

export function splitInput(value: unknown, currency: string, parentMinor: bigint) {
  const rows = z.array(z.object({ amount: z.string(), categoryId: z.uuid().nullable(), note: z.string().trim().max(500) }).strict()).min(2).max(20).parse(value);
  const result = rows.map(row => ({ amount_minor: parseManualAmount(row.amount, currency).toString(), category_id: row.categoryId, note: row.note }));
  const amounts = result.map(row => BigInt(row.amount_minor));
  if (amounts.some(amount => amount === 0n || (amount > 0n) !== (parentMinor > 0n)) || amounts.reduce((sum, amount) => sum + amount, 0n) !== parentMinor)
    throw new Error("Allocations must have the source direction and exactly equal its amount");
  return result;
}
