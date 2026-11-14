import { z } from "zod";

// The ```moneo-chart spec. Model-written charts can only use these fields, so no code or styling reaches the page.
// The server resolves dataset references and validates every block before an answer is saved; the client parses again.

const amount = z.string().regex(/^-?(?:0|[1-9]\d{0,17})$/, "Values are whole minor-unit strings");
const positive = amount.refine(value => !value.startsWith("-") && value !== "0", "Values must be above zero");
const notNegative = amount.refine(value => !value.startsWith("-"), "Values must not be negative");
const text = z.string().trim().min(1).max(60);
const currency = z.string().regex(/^[A-Z]{3}$/);
const unit = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("money"), currency }).strict(),
  z.object({ kind: z.literal("count") }).strict(),
]);
const href = z.string().max(500).regex(/^\/money\/transactions\?[\w=&%.-]*$/).optional();
const header = { title: z.string().trim().min(1).max(80), unit };
const MAX_POINTS = 400;
const labels = z.array(text).min(2).max(MAX_POINTS);
const values = z.array(amount).min(1).max(MAX_POINTS);
/** A horizontal line: a fixed amount ("Budget") or the average of one series, worked out by the app. */
const reference = z.union([
  z.object({ label: text, value: amount }).strict(),
  z.object({ label: text, average: text }).strict(),
]);
/** A vertical line at one of the labels ("Today"). */
const marker = z.object({ label: text, at: text }).strict();
const annotations = { references: z.array(reference).max(3).optional(), markers: z.array(marker).max(3).optional() };

const sameLength = (chart: { labels: string[]; series: { values: string[] }[] }) => chart.series.every(series => series.values.length === chart.labels.length);
function annotationsFit(chart: { labels: string[]; series: { name: string }[]; references?: z.infer<typeof reference>[]; markers?: z.infer<typeof marker>[] }) {
  return (chart.references ?? []).every(item => !("average" in item) || chart.series.some(series => series.name === item.average))
    && (chart.markers ?? []).every(item => chart.labels.includes(item.at));
}
const annotationMessage = "References average a named series and markers sit on a label";

const cartesian = z.object({
  ...header, ...annotations,
  type: z.enum(["bar", "line", "area"]),
  horizontal: z.boolean().optional(),
  stacked: z.boolean().optional(),
  labels,
  series: z.array(z.object({ name: text, values }).strict()).min(1).max(4),
}).strict()
  .refine(sameLength, "Each series needs one value per label")
  .refine(chart => !chart.horizontal || chart.labels.length <= 40, "Horizontal bars take at most 40 labels")
  .refine(annotationsFit, annotationMessage);

/** Bars and lines on one chart; a line may use a second scale on the right (e.g. a balance beside monthly spending). */
const combo = z.object({
  ...header, ...annotations,
  type: z.literal("combo"),
  labels,
  series: z.array(z.object({ name: text, values, as: z.enum(["bar", "line"]), axis: z.enum(["left", "right"]).optional() }).strict()).min(2).max(4),
}).strict()
  .refine(sameLength, "Each series needs one value per label")
  .refine(chart => chart.series.some(series => series.axis !== "right"), "At least one series uses the left axis")
  .refine(annotationsFit, annotationMessage);

/** Lines with a shaded range, such as a forecast between its low and high case. */
const band = z.object({
  ...header, ...annotations,
  type: z.literal("band"),
  labels,
  series: z.array(z.object({ name: text, values }).strict()).min(1).max(3),
  band: z.object({ name: text, low: values, high: values }).strict(),
}).strict()
  .refine(sameLength, "Each series needs one value per label")
  .refine(chart => chart.band.low.length === chart.labels.length && chart.band.high.length === chart.labels.length, "The band needs one low and high per label")
  .refine(chart => chart.band.low.every((low, index) => BigInt(low) <= BigInt(chart.band.high[index])), "Band lows must not be above highs")
  .refine(annotationsFit, annotationMessage);

/** Signed steps from an optional start; the app adds them up for the end bar, so the bridge always balances. */
const waterfall = z.object({
  ...header,
  type: z.literal("waterfall"),
  start: z.object({ label: text, value: amount }).strict().optional(),
  steps: z.array(z.object({ label: text, value: amount }).strict()).min(1).max(30),
  end: z.object({ label: text }).strict().optional(),
}).strict();

const sankey = z.object({
  ...header,
  type: z.literal("sankey"),
  links: z.array(z.object({ from: text, to: text, value: positive }).strict()).min(1).max(60),
}).strict()
  .refine(chart => chart.links.every(link => link.from !== link.to), "A flow cannot go to itself")
  .refine(chart => new Set(chart.links.flatMap(link => [link.from, link.to])).size <= 40, "At most 40 nodes")
  .refine(chart => acyclic(chart.links), "Flows cannot loop back");

const point = z.object({ x: amount, y: amount, label: text.optional() }).strict();
const scatter = z.object({
  ...header,
  type: z.literal("scatter"),
  xTitle: text, yTitle: text,
  xUnit: unit,
  series: z.array(z.object({ name: text, points: z.array(point).min(1).max(1000) }).strict()).min(1).max(4),
}).strict().refine(chart => chart.series.reduce((sum, series) => sum + series.points.length, 0) <= 1000, "At most 1000 points");

const isoDate = z.iso.date();
const calendar = z.object({
  ...header,
  type: z.literal("calendar"),
  days: z.array(z.object({ date: isoDate, value: notNegative }).strict()).min(1).max(366),
}).strict()
  .refine(chart => new Set(chart.days.map(day => day.date)).size === chart.days.length, "Each date appears once")
  .refine(chart => {
    const dates = chart.days.map(day => Date.parse(day.date)).sort((a, b) => a - b);
    return (dates.at(-1)! - dates[0]) / 86_400_000 < 366;
  }, "Days span at most a year");

const circular = z.object({
  ...header,
  type: z.enum(["pie", "donut", "treemap", "bubble"]),
  items: z.array(z.object({ label: text, value: notNegative, href }).strict()).min(2).max(20),
}).strict();

export const chartSchema = z.union([cartesian, combo, band, waterfall, sankey, scatter, calendar, circular]);
export type ChartSpec = z.infer<typeof chartSchema>;
export type ChartUnit = ChartSpec["unit"];
export type CartesianSpec = z.infer<typeof cartesian>;
export type ComboSpec = z.infer<typeof combo>;
export type BandSpec = z.infer<typeof band>;
export type WaterfallSpec = z.infer<typeof waterfall>;
export type SankeySpec = z.infer<typeof sankey>;
export type ScatterSpec = z.infer<typeof scatter>;
export type CalendarSpec = z.infer<typeof calendar>;
export type CircularSpec = z.infer<typeof circular>;
export type ReferenceLine = z.infer<typeof reference>;

function acyclic(links: { from: string; to: string }[]) {
  const next = new Map<string, string[]>();
  for (const link of links) next.set(link.from, [...next.get(link.from) ?? [], link.to]);
  const state = new Map<string, "open" | "done">();
  const visit = (node: string): boolean => {
    if (state.get(node) === "done") return true;
    if (state.get(node) === "open") return false;
    state.set(node, "open");
    const ok = (next.get(node) ?? []).every(visit);
    state.set(node, "done");
    return ok;
  };
  return [...next.keys()].every(visit);
}

/** Average of minor units, rounded half away from zero, so a reference line is exact to the cent. */
export function averageMinor(items: string[]): bigint {
  if (!items.length) return 0n;
  const sum = items.reduce((total, item) => total + BigInt(item), 0n), count = BigInt(items.length);
  const quotient = sum / count, remainder = sum % count;
  const away = (remainder < 0n ? -remainder : remainder) * 2n >= count;
  return away ? quotient + (sum < 0n ? -1n : 1n) : quotient;
}

/** The waterfall's bars: the start, each step floating from the running total, and the end the app worked out. */
export function waterfallBars(chart: WaterfallSpec) {
  let running = chart.start ? BigInt(chart.start.value) : 0n;
  const bars: { label: string; kind: "total" | "step"; from: bigint; to: bigint; value: bigint }[] = [];
  if (chart.start) bars.push({ label: chart.start.label, kind: "total", from: 0n, to: running, value: running });
  for (const step of chart.steps) {
    const value = BigInt(step.value);
    bars.push({ label: step.label, kind: "step", from: running, to: running + value, value });
    running += value;
  }
  if (chart.end) bars.push({ label: chart.end.label, kind: "total", from: 0n, to: running, value: running });
  return bars;
}

export type ParsedChart = { ok: true; chart: ChartSpec } | { ok: false; error: string };

export function parseChart(source: unknown): ParsedChart {
  const parsed = chartSchema.safeParse(source);
  if (parsed.success) return { ok: true, chart: parsed.data };
  const issue = parsed.error.issues[0];
  return { ok: false, error: issue?.message && !issue.message.startsWith("Invalid") ? issue.message : "The chart data doesn't fit its type" };
}

// ---- Datasets: exact rows from tools (chart_data and data_query) that a chart references instead of copying numbers.

const columnName = z.string().min(1).max(60);
export const chartColumnSchema = z.union([
  z.object({ kind: z.enum(["text", "date", "count"]) }).strict(),
  z.object({ kind: z.literal("money"), currency }).strict(),
  /** Rows in several currencies: each row names its own, and a chart takes only rows in its unit's currency. */
  z.object({ kind: z.literal("money"), currencyColumn: columnName }).strict(),
]);
export const chartDatasetSchema = z.object({
  columns: z.record(columnName, chartColumnSchema),
  rows: z.array(z.record(columnName, z.string().max(200).nullable())).max(5000),
}).strict().refine(dataset => Object.values(dataset.columns).every(column => !("currencyColumn" in column) || dataset.columns[column.currencyColumn]?.kind === "text"), "A currency column must be a text column");
export type ChartDataset = z.infer<typeof chartDatasetSchema>;
export type ChartColumn = ChartDataset["columns"][string];

/** Per-request store of datasets; ids are handed to the model and resolved before the answer is saved. */
export function chartDatasets(prefix = "chart") {
  const stored = new Map<string, ChartDataset>();
  return {
    add(dataset: ChartDataset) {
      const id = `${prefix}_${stored.size + 1}`;
      stored.set(id, chartDatasetSchema.parse(dataset));
      return id;
    },
    get: (id: string) => stored.get(id),
  };
}

const datasetRef = z.object({ datasetId: z.string().min(1).max(60), where: z.record(columnName, z.string().max(200)).optional() }).passthrough();
// Lists whose entries are objects: a reference maps each field to a column, e.g. "items": {"label": "category", "value": "amount"}.
const ROW_LISTS = new Set(["items", "steps", "links", "points", "days"]);
const NUMERIC = new Set(["values", "low", "high", "value", "x", "y"]);
const OPTIONAL = new Set(["href", "label"]);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

class ChartDataError extends Error {}

/**
 * Turns a chart that references a dataset into an inline chart with the dataset's exact values. Any list in the spec can
 * be {"column": name}; a list of objects maps its fields to columns. Money columns must be in the chart unit's currency.
 */
export function resolveChart(source: unknown, lookup: (id: string) => ChartDataset | undefined): ParsedChart {
  if (!isObject(source) || !("datasetId" in source)) return parseChart(source);
  const ref = datasetRef.safeParse(source);
  if (!ref.success) return { ok: false, error: "The dataset reference is invalid" };
  const dataset = lookup(ref.data.datasetId);
  if (!dataset) return { ok: false, error: "The chart's data was not loaded in this answer" };
  const units = { y: unit.safeParse(source.unit).data, x: unit.safeParse(source.xUnit).data };
  try {
    for (const name of Object.keys(ref.data.where ?? {})) if (!dataset.columns[name]) throw new ChartDataError(`No column named ${name}`);
    const rows = dataset.rows.filter(row => Object.entries(ref.data.where ?? {}).every(([name, value]) => row[name] === value));
    const column = (name: unknown, field: string) => {
      if (typeof name !== "string" || !dataset.columns[name]) throw new ChartDataError(`No column named ${String(name)}`);
      const kind = dataset.columns[name];
      const target = field === "x" ? units.x : units.y;
      if (NUMERIC.has(field)) {
        if (kind.kind === "text" || kind.kind === "date") throw new ChartDataError(`Column ${name} has no amounts`);
        if (target?.kind === "count" && kind.kind === "money") throw new ChartDataError(`Column ${name} is money but the chart counts`);
        if (target?.kind === "money" && kind.kind !== "money") throw new ChartDataError(`Column ${name} is not money`);
      } else if (kind.kind === "money") throw new ChartDataError(`Column ${name} holds amounts, not labels`);
      return rows.map(row => {
        const value = row[name];
        if (value === null || value === undefined) {
          // An optional field (a link or point label) is simply left off a row without one.
          if (OPTIONAL.has(field)) return null;
          throw new ChartDataError(`Column ${name} has empty values`);
        }
        if (NUMERIC.has(field) && kind.kind === "money" && target?.kind === "money") {
          const rowCurrency = "currency" in kind ? kind.currency : row[kind.currencyColumn];
          if (rowCurrency !== target.currency) throw new ChartDataError(`Column ${name} is in ${rowCurrency ?? "an unknown currency"}, not ${target.currency}`);
        }
        return value;
      });
    };
    const resolve = (node: unknown, key: string): unknown => {
      if (Array.isArray(node)) return node.map(child => resolve(child, key));
      if (!isObject(node)) return node;
      if (Object.keys(node).length === 1 && "column" in node) return column(node.column, key);
      if (ROW_LISTS.has(key)) {
        const fields = Object.entries(node).map(([field, name]) => [field, column(name, field)] as const);
        return rows.map((_, index) => Object.fromEntries(fields.flatMap(([field, list]) => list[index] === null ? [] : [[field, list[index]]])));
      }
      return Object.fromEntries(Object.entries(node).map(([field, child]) => [field, resolve(child, field)]));
    };
    const { datasetId, where, ...chart } = source;
    void datasetId; void where;
    return parseChart(resolve(chart, ""));
  } catch (error) {
    if (error instanceof ChartDataError) return { ok: false, error: error.message };
    throw error;
  }
}

const BLOCK = /```moneo-chart\n([\s\S]*?)```/g;

/**
 * Every chart block in an answer, checked and with dataset references replaced by their exact values, so the saved
 * answer is self-contained. A block that can't be drawn says why instead.
 */
export function resolveChartBlocks(answer: string, lookup: (id: string) => ChartDataset | undefined) {
  return answer.replace(BLOCK, (_, body: string) => {
    let source: unknown;
    try { source = JSON.parse(body); } catch { source = undefined; }
    const result = source === undefined ? { ok: false as const, error: "The chart isn't valid JSON" } : resolveChart(source, lookup);
    return "```moneo-chart\n" + JSON.stringify(result.ok ? result.chart : { unavailable: result.error }) + "\n```";
  });
}
