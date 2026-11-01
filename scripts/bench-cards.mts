// Measures the card sandbox: engine start, compile, and a render of a busy card (two charts, a 12-row list).
// Run: npx tsx scripts/bench-cards.mts
import { compileCard, runCard } from "../lib/cards/sandbox.ts";

const source = `
type Row = { name: string; total_minor: string; total_formatted: string };
export default function Card({ data, params, size }: { data: any; params: Record<string, string>; size: string }) {
  const rows: Row[] = data.byCategory.rows;
  const max = Math.max(...rows.map(row => Number(row.total_minor)));
  return <div className="card" style={{ display: "grid", gap: 12 }}>
    <Kit.Style css={".hero{font-size:40px;animation:pop .4s ease} @keyframes pop{from{opacity:0}to{opacity:1}}"} />
    <p className="hero">{data.month.spending_formatted}</p>
    <Kit.Chart type="line" labels={data.trend.labels} series={[{ name: "Spent", values: data.trend.values }]} />
    <Kit.Chart type="bar" labels={data.trend.labels} series={[{ name: "In", values: data.trend.values }]} />
    <ul>{rows.map(row => <li key={row.name}><span>{row.name}</span><svg width="100" height="6"><rect width={100 * Number(row.total_minor) / max} height="6" rx="3" fill="var(--brand)" /></svg><Kit.Money minor={row.total_minor} currency="EUR" /></li>)}</ul>
    {size !== "S" && <Kit.Tabs tabs={[{ label: "A", content: <b>a</b> }, { label: "B", content: <i>b</i> }]} />}
  </div>;
}`;
const data = {
  month: { spending_formatted: "€1,240.00" },
  byCategory: { rows: Array.from({ length: 12 }, (_, i) => ({ name: `Category ${i}`, total_minor: String(10000 + i * 1234), total_formatted: "€" + i })) },
  trend: { labels: Array.from({ length: 12 }, (_, i) => `M${i}`), values: Array.from({ length: 12 }, (_, i) => 1000 + i * 37) },
};
const time = async <T>(label: string, run: () => T | Promise<T>) => { const start = performance.now(); const out = await run(); console.log(label.padEnd(28), (performance.now() - start).toFixed(1), "ms"); return out; };

const compiled = await time("compile (sucrase)", () => compileCard(source));
await time("first render (engine cold)", () => runCard(compiled, { data, params: {}, size: "M" }));
const runs: number[] = [];
for (let i = 0; i < 50; i++) { const start = performance.now(); await runCard(compiled, { data, params: {}, size: "M" }); runs.push(performance.now() - start); }
runs.sort((a, b) => a - b);
console.log("warm render p50 / p95".padEnd(28), runs[25].toFixed(2), "/", runs[47].toFixed(2), "ms");
const start = performance.now();
await Promise.all(Array.from({ length: 8 }, () => runCard(compiled, { data, params: {}, size: "M" })));
console.log("8 cards at once".padEnd(28), (performance.now() - start).toFixed(1), "ms");
