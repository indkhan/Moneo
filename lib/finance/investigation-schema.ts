import { z } from "zod";
import { minorDigits } from "./fx";

const period = z.object({ from: z.iso.date(), to: z.iso.date() }).strict().refine(p => p.from <= p.to, "From date is after to date");
const entity = z.union([z.object({ id: z.uuid() }).strict(), z.object({ name: z.string().trim().min(1).max(120) }).strict()]);
const entityFilter = z.object({ include: z.array(entity).max(100).optional(), exclude: z.array(entity).max(100).optional() }).strict();
const labelFilter = z.object({ include: z.array(z.string().trim().min(1).max(120)).max(100).optional(), exclude: z.array(z.string().trim().min(1).max(120)).max(100).optional() }).strict();
export const investigationSchema = z.object({
  version: z.literal(1), period, comparison: period.optional(),
  accounts: entityFilter.optional(), categories: entityFilter.optional(), merchants: entityFilter.optional(),
  tags: labelFilter.optional(), events: labelFilter.optional(),
  statuses: z.array(z.enum(["posted", "pending"])).min(1).max(2).default(["posted"]),
  classifications: z.enum(["resolved", "all", "unresolved"]).default("resolved"),
  kinds: z.array(z.enum(["ordinary", "refund", "transfer"])).min(1).max(3).default(["ordinary", "refund"]),
  currencyPolicy: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("original"), currencies: z.array(z.string().regex(/^[A-Z]{3}$/)).min(1).max(50).optional() }).strict(),
    z.object({ mode: z.literal("base"), currency: z.string().regex(/^[A-Z]{3}$/).refine(c => { try { minorDigits(c); return true; } catch { return false; } }) }).strict(),
  ]).default({ mode: "original" }),
  metric: z.enum(["spending", "income", "net", "signed", "absolute", "count"]).default("spending"),
  groupBy: z.array(z.enum(["account", "category", "merchant", "tag", "event", "date", "month", "kind", "status"])).max(5).default([]).refine(a => new Set(a).size === a.length, "Duplicate grouping dimension"),
  sort: z.enum(["delta-desc", "delta-asc", "absolute-delta-desc", "current-desc", "current-asc", "key"]).default("absolute-delta-desc"),
  page: z.object({ size: z.number().int().min(1).max(100).default(25), cursor: z.string().max(1000).optional(), groupKey: z.string().max(2000).optional(), period: z.enum(["current", "comparison", "both"]).default("both") }).strict().default({ size: 25, period: "both" }),
}).strict();
export type InvestigationSpec = z.infer<typeof investigationSchema>;
