import { z } from "zod";
import { resolveToken, type ResolvedParams } from "@/lib/ai/artifact-data";

const name = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]{0,39}$/);
const PERIODS = { "7d": "7 days", "30d": "30 days", "90d": "90 days", "6m": "6 months", "12m": "12 months", mtd: "This month", ytd: "This year" } as const;
type Period = keyof typeof PERIODS;

const label = z.string().trim().min(1).max(40);

/**
 * Controls a card offers on Home. Month, period and choice values are only ever picked from their options, so a
 * request can't widen what a card reads. Number (a slider) and toggle values never reach a query: they only feed
 * the card's own calculation, so the browser reruns the card as they move.
 */
export const cardParamSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("month"), name, months: z.number().int().min(2).max(24).default(12), default: z.enum(["current", "previous"]).default("current") }).strict(),
  z.object({ kind: z.literal("period"), name, options: z.array(z.enum(Object.keys(PERIODS) as [Period, ...Period[]])).min(2).max(7), default: z.enum(Object.keys(PERIODS) as [Period, ...Period[]]) }).strict(),
  z.object({ kind: z.literal("choice"), name, options: z.array(z.object({ value: z.string().min(1).max(100), label: z.string().min(1).max(40) }).strict()).min(2).max(12), default: z.string().min(1).max(100) }).strict(),
  z.object({ kind: z.literal("number"), name, label, min: z.number().finite(), max: z.number().finite(), step: z.number().finite().positive(), default: z.number().finite(),
    format: z.enum(["number", "money", "percent"]).default("number"), currency: z.string().regex(/^[A-Z]{3}$/).optional() }).strict()
    .refine(param => param.min < param.max && param.default >= param.min && param.default <= param.max, "A number param needs min < max and its default between them")
    .refine(param => (param.max - param.min) / param.step <= 10_000, "A number param can have at most 10,000 steps")
    .refine(param => param.format !== "money" || (param.currency && Number.isInteger(param.min) && Number.isInteger(param.step)), "A money param needs a currency, and min and step in minor units"),
  z.object({ kind: z.literal("toggle"), name, label, default: z.boolean() }).strict(),
]);
export const cardParamsSchema = z.array(cardParamSchema).max(6).refine(params => new Set(params.map(param => param.name)).size === params.length, "Param names must be unique")
  .refine(params => params.every(param => param.kind === "month" || param.kind === "number" || param.kind === "toggle" || (param.kind === "period" ? param.options.includes(param.default) : param.options.some(option => option.value === param.default))), "Each default must be one of its options");
export type CardParam = z.infer<typeof cardParamSchema>;
/** A slider or a switch: its value lives in the browser and only the card's code reads it. */
export type LocalControl = { kind: "number"; label: string; min: number; max: number; step: number; format: "number" | "money" | "percent"; currency?: string } | { kind: "toggle"; label: string };
/** What the card (and its controls) are told: each param's value and the options to pick from, or its local control. */
export type ParamState = { name: string; value: string; options: { value: string; label: string }[]; control?: LocalControl };

/** A number on the slider's grid: clamped to its range and rounded to its step. */
const snap = (value: number, { min, max, step }: { min: number; max: number; step: number }) =>
  Number(Math.min(max, Math.max(min, min + Math.round((value - min) / step) * step)).toPrecision(12));

function periodRange(period: Period, today: string) {
  const from = period === "mtd" ? resolveToken("@month_start", today)
    : period === "ytd" ? resolveToken("@year_start", today)
    : period.endsWith("m") ? resolveToken(`@month_start:${1 - Number(period.slice(0, -1))}`, today)
    : resolveToken(`@days_ago:${Number(period.slice(0, -1)) - 1}`, today);
  return { from, to: today };
}

/** Requested values checked against each param's options; anything else falls back to the default. */
export function resolveParams(declared: CardParam[], requested: Record<string, string | undefined>, today: string, locale = "en"): { resolved: ResolvedParams; state: ParamState[] } {
  const resolved: ResolvedParams = { values: {}, ranges: {} };
  const state = declared.map((param): ParamState => {
    const wanted = requested[param.name];
    if (param.kind === "month") {
      const options = Array.from({ length: param.months }, (_, index) => {
        const start = resolveToken(`@month_start:${-index}`, today);
        return { value: start.slice(0, 7), label: new Intl.DateTimeFormat(locale, { month: "short", year: index >= 12 || start.slice(0, 4) !== today.slice(0, 4) ? "2-digit" : undefined, timeZone: "UTC" }).format(new Date(`${start}T00:00:00Z`)) };
      }).reverse();
      const value = options.some(option => option.value === wanted) ? wanted! : resolveToken(param.default === "previous" ? "@month_start:-1" : "@month_start", today).slice(0, 7);
      const from = `${value}-01`;
      const offset = (Number(value.slice(0, 4)) - Number(today.slice(0, 4))) * 12 + Number(value.slice(5, 7)) - Number(today.slice(5, 7));
      resolved.ranges[param.name] = { from, to: offset === 0 ? today : resolveToken(`@month_end:${offset}`, today) };
      resolved.values[param.name] = value;
      return { name: param.name, value, options };
    }
    if (param.kind === "period") {
      const value = (param.options as string[]).includes(wanted ?? "") ? wanted as Period : param.default;
      resolved.ranges[param.name] = periodRange(value, today);
      resolved.values[param.name] = value;
      return { name: param.name, value, options: param.options.map(option => ({ value: option, label: PERIODS[option] })) };
    }
    if (param.kind === "number") {
      const asked = wanted === undefined || wanted.trim() === "" ? NaN : Number(wanted);
      const value = Number.isFinite(asked) ? snap(asked, param) : param.default;
      const { kind, label, min, max, step, format, currency } = param;
      return { name: param.name, value: String(value), options: [], control: { kind, label, min, max, step, format, ...(currency ? { currency } : {}) } };
    }
    if (param.kind === "toggle") return { name: param.name, value: String(wanted === "true" ? true : wanted === "false" ? false : param.default), options: [], control: { kind: "toggle", label: param.label } };
    const value = param.options.some(option => option.value === wanted) ? wanted! : param.default;
    resolved.values[param.name] = value;
    return { name: param.name, value, options: param.options };
  });
  return { resolved, state };
}
