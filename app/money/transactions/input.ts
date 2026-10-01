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

export const versionedRows = z.array(z.object({ id: z.uuid(), version: z.number().int().min(0).max(2147483647) }).strict()).min(1).max(50)
  .refine(rows => new Set(rows.map(row => row.id)).size === rows.length, "Select each transaction once");

export function bulkInput(value: unknown) {
  const input = z.object({ rows: versionedRows, requestId: z.uuid(), confirmed: z.literal("true"), mode: z.enum(["category", "tags", "event"]), value: z.string().max(1000) }).parse(value);
  let patch: Record<string, unknown>;
  if (input.mode === "category") patch = { category_id: input.value ? z.uuid().parse(input.value) : null };
  else if (input.mode === "event") patch = { event_name: z.string().trim().max(120).parse(input.value) || null };
  else patch = { tags: z.array(z.string().min(1).max(40)).max(20).parse([...new Set(input.value.split(",").map(tag => tag.trim().toLowerCase()).filter(Boolean))].sort()) };
  return { rows: input.rows, requestId: input.requestId, patch };
}
