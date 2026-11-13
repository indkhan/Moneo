import { describe, expect, it } from "vitest";
import { averageMinor, chartDatasets, parseChart, resolveChart, resolveChartBlocks, waterfallBars, type ChartDataset, type WaterfallSpec } from "./chart-spec";

const eur = { kind: "money", currency: "EUR" } as const;
const days = (count: number) => Array.from({ length: count }, (_, index) => new Date(Date.UTC(2026, 0, 1) + index * 86_400_000).toISOString().slice(0, 10));

describe("chart spec", () => {
  it("takes a year of daily points and the new chart types", () => {
    const labels = days(366);
    expect(parseChart({ type: "line", title: "Balance", unit: eur, labels, series: [{ name: "Checking", values: labels.map(() => "100") }],
      references: [{ label: "Average", average: "Checking" }], markers: [{ label: "Today", at: labels[200] }] }).ok).toBe(true);
    expect(parseChart({ type: "combo", title: "Spending and balance", unit: eur, labels: ["2026-01", "2026-02"],
      series: [{ name: "Spending", as: "bar", values: ["1", "2"] }, { name: "Balance", as: "line", axis: "right", values: ["10", "20"] }] }).ok).toBe(true);
    expect(parseChart({ type: "sankey", title: "Flow", unit: eur, links: [{ from: "Income", to: "Rent", value: "95000" }, { from: "Income", to: "Food", value: "1" }] }).ok).toBe(true);
    expect(parseChart({ type: "calendar", title: "Daily", unit: eur, days: labels.map(date => ({ date, value: "0" })) }).ok).toBe(true);
    expect(parseChart({ type: "scatter", title: "Buys", unit: eur, xTitle: "Day", yTitle: "Amount", xUnit: { kind: "count" }, series: [{ name: "Food", points: [{ x: "3", y: "1250" }] }] }).ok).toBe(true);
  });

  it("rejects specs that would draw something false", () => {
    const band = { type: "band", title: "Forecast", unit: eur, labels: ["a", "b"], series: [{ name: "Expected", values: ["5", "6"] }], band: { name: "Range", low: ["4", "7"], high: ["6", "6"] } };
    expect(parseChart(band).ok).toBe(false);
    expect(parseChart({ type: "sankey", title: "Loop", unit: eur, links: [{ from: "A", to: "B", value: "1" }, { from: "B", to: "A", value: "1" }] }).ok).toBe(false);
    expect(parseChart({ type: "combo", title: "x", unit: eur, labels: ["a", "b"], series: [{ name: "s", as: "line", axis: "right", values: ["1", "2"] }, { name: "t", as: "bar", axis: "right", values: ["1", "2"] }] }).ok).toBe(false);
    expect(parseChart({ type: "line", title: "x", unit: eur, labels: ["a", "b"], series: [{ name: "s", values: ["1", "2"] }], markers: [{ label: "Today", at: "c" }] }).ok).toBe(false);
    expect(parseChart({ type: "bar", title: "x", unit: eur, labels: days(401), series: [{ name: "s", values: days(401).map(() => "1") }] }).ok).toBe(false);
    expect(parseChart({ type: "calendar", title: "x", unit: eur, days: [{ date: "2025-01-01", value: "1" }, { date: "2026-01-02", value: "1" }] }).ok).toBe(false);
    expect(parseChart({ type: "pie", title: "x", unit: eur, items: [{ label: "a", value: "1" }, { label: "b", value: "2" }], color: "red" }).ok).toBe(false);
  });

  it("averages minor units half away from zero", () => {
    expect(averageMinor(["1", "2"])).toBe(2n);
    expect(averageMinor(["1", "1", "2"])).toBe(1n);
    expect(averageMinor(["-1", "-2"])).toBe(-2n);
    expect(averageMinor(["99999999999999999", "99999999999999998"])).toBe(99999999999999999n);
  });

  it("ends a waterfall at exactly the start plus every step", () => {
    const chart = parseChart({ type: "waterfall", title: "October", unit: eur, start: { label: "Oct 1", value: "455001" },
      steps: [{ label: "Salary", value: "310000" }, { label: "Rent", value: "-95000" }, { label: "Food", value: "-38423" }], end: { label: "Oct 31" } });
    if (!chart.ok) throw new Error(chart.error);
    const bars = waterfallBars(chart.chart as WaterfallSpec);
    expect(bars.at(-1)).toMatchObject({ kind: "total", value: 631578n });
    expect(bars[2]).toMatchObject({ from: 765001n, to: 670001n });
  });
});

describe("dataset references", () => {
  const spending: ChartDataset = {
    columns: { category: { kind: "text" }, spending: { kind: "money", currency: "EUR" }, link: { kind: "text" } },
    rows: [{ category: "Rent", spending: "9500000000000001", link: "/money/transactions?category=none" }, { category: "Other", spending: "1", link: null }],
  };
  const store = chartDatasets();
  const id = store.add(spending);

  it("fills a chart with the dataset's exact minor units", () => {
    const resolved = resolveChart({ type: "donut", title: "Where it went", unit: eur, datasetId: id, items: { label: "category", value: "spending", href: "link" } }, store.get);
    expect(resolved).toEqual({ ok: true, chart: { type: "donut", title: "Where it went", unit: eur,
      items: [{ label: "Rent", value: "9500000000000001", href: "/money/transactions?category=none" }, { label: "Other", value: "1" }] } });
    const bars = resolveChart({ type: "bar", title: "x", unit: eur, datasetId: id, labels: { column: "category" }, series: [{ name: "Spent", values: { column: "spending" } }] }, store.get);
    expect(bars.ok && "series" in bars.chart && bars.chart.series[0].values).toEqual(["9500000000000001", "1"]);
  });

  it("rejects money in another currency, a missing dataset, and amounts used as labels", () => {
    expect(resolveChart({ type: "pie", title: "x", unit: { kind: "money", currency: "USD" }, datasetId: id, items: { label: "category", value: "spending" } }, store.get))
      .toEqual({ ok: false, error: "Column spending is in EUR, not USD" });
    expect(resolveChart({ type: "pie", title: "x", unit: { kind: "count" }, datasetId: id, items: { label: "category", value: "spending" } }, store.get).ok).toBe(false);
    expect(resolveChart({ type: "pie", title: "x", unit: eur, datasetId: "chart_99", items: { label: "category", value: "spending" } }, store.get).ok).toBe(false);
    expect(resolveChart({ type: "pie", title: "x", unit: eur, datasetId: id, items: { label: "spending", value: "spending" } }, store.get).ok).toBe(false);
  });

  it("takes rows in mixed currencies only after filtering to the chart's currency", () => {
    const rows = chartDatasets("query");
    const mixed = rows.add({ columns: { month: { kind: "date" }, currency: { kind: "text" }, total: { kind: "money", currencyColumn: "currency" } },
      rows: [{ month: "2026-01", currency: "EUR", total: "100" }, { month: "2026-01", currency: "USD", total: "900" }, { month: "2026-02", currency: "EUR", total: "250" }] });
    const chart = { type: "line", title: "x", unit: eur, datasetId: mixed, labels: { column: "month" }, series: [{ name: "Total", values: { column: "total" } }] };
    expect(resolveChart(chart, rows.get)).toEqual({ ok: false, error: "Column total is in USD, not EUR" });
    const filtered = resolveChart({ ...chart, where: { currency: "EUR" } }, rows.get);
    expect(filtered.ok && "series" in filtered.chart && filtered.chart.series[0].values).toEqual(["100", "250"]);
  });

  it("makes every block in an answer self-contained or says why it can't be drawn", () => {
    const answer = `Here:\n\`\`\`moneo-chart\n${JSON.stringify({ type: "pie", title: "x", unit: eur, datasetId: id, items: { label: "category", value: "spending" } })}\n\`\`\`\nand\n\`\`\`moneo-chart\n{"type":"bar"\n\`\`\``;
    const resolved = resolveChartBlocks(answer, store.get);
    expect(resolved).toContain('"value":"9500000000000001"');
    expect(resolved).not.toContain("datasetId");
    expect(resolved).toContain('{"unavailable":"The chart isn\'t valid JSON"}');
    expect(resolved.match(/```moneo-chart\n/g)).toHaveLength(2);
  });
});
