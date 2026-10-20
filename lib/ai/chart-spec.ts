import { z } from "zod";

export const CHART_MAX_POINTS = 500;
export const CHART_MAX_SERIES = 12;

const label = z.union([z.string().trim().max(80), z.number().finite()]);
const series = z.object({
  name: z.string().trim().min(1).max(80),
  data: z.array(z.number().finite().nullable()).min(1).max(CHART_MAX_POINTS),
  unit: z.string().trim().max(16).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
}).strict();

/** A model-written ```chart block: plain text labels and numbers only, no HTML or links. */
export const chartSpecSchema = z.preprocess(value => {
  // `labels` is accepted as an alias of `x`.
  if (value && typeof value === "object" && !Array.isArray(value) && "labels" in value && !("x" in value)) {
    const { labels, ...rest } = value as Record<string, unknown>;
    return { ...rest, x: labels };
  }
  return value;
}, z.object({
  type: z.enum(["bar", "line", "area", "pie", "scatter"]),
  title: z.string().trim().max(120).optional(),
  x: z.array(label).max(CHART_MAX_POINTS).optional(),
  series: z.array(series).min(1).max(CHART_MAX_SERIES),
  stacked: z.boolean().optional(),
}).strict()
  .refine(spec => spec.series.reduce((sum, item) => sum + item.data.length, 0) <= CHART_MAX_POINTS * 4, "Too many points")
  .refine(spec => !spec.x || spec.series.every(item => item.data.length === spec.x!.length), "Each series needs one value per x label")
  .refine(spec => spec.type !== "pie" || (spec.series.length === 1 && Boolean(spec.x)), "A pie chart has one series and x labels"));

export type ChartSpec = z.infer<typeof chartSpecSchema>;

export function parseChartSpec(source: string): ChartSpec | null {
  try {
    const parsed = chartSpecSchema.safeParse(JSON.parse(source));
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

/** One value as text, with its series currency or unit. */
export function chartValue(value: number | null | undefined, item: { currency?: string; unit?: string }) {
  if (value === null || value === undefined) return "–";
  const number = value.toLocaleString("en", { maximumFractionDigits: 2 });
  return item.currency ? `${item.currency} ${number}` : item.unit ? `${number} ${item.unit}` : number;
}
