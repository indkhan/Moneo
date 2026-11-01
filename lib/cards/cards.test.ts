import { describe, expect, it } from "vitest";
import { compileCard, runCard } from "./sandbox";
import { CardTreeError, sanitizeTree, scopeCss } from "./tree";
import { resolveParams } from "./params";
import { PRESETS, presetSource } from "./presets";

const render = async (source: string, data: unknown = {}, params: Record<string, string> = {}, size = "M") =>
  sanitizeTree(await runCard(compileCard(source), { data, params, size }), { scope: "c1" });

// The first render starts the WASM engine and one test waits out the runaway-loop deadline; give them room on a busy machine.
describe("card sandbox", { timeout: 20_000 }, () => {
  it("runs a card's React in QuickJS and returns plain elements, Kit names included", async () => {
    const tree = await render(`export default function Card({ data, size }) {
      const Row = ({ label }: { label: string }) => <li>{label}</li>;
      return <div className="x"><ul>{data.rows.map((row: any) => <Row key={row} label={row} />)}</ul><Kit.Money minor="1250" currency="EUR" />{size === "S" && <b>small</b>}</div>;
    }`, { rows: ["a", "b"] });
    expect(tree).toEqual({ type: "div", props: { className: "x" }, children: [
      { type: "ul", props: {}, children: [{ type: "li", props: {}, children: ["a"] }, { type: "li", props: {}, children: ["b"] }] },
      { type: "kit:Money", props: { minor: "1250", currency: "EUR" }, children: [] },
    ] });
  });

  it("gives a card no way out: no imports, no host globals, and a runaway loop is stopped", async () => {
    await expect(runCard(compileCard(`import fs from "fs"; export default () => <p>{String(fs)}</p>;`), { data: {}, params: {}, size: "M" })).rejects.toThrow("cannot import");
    const globals = await render(`export default () => <p>{[typeof process, typeof fetch, typeof globalThis.require, typeof setTimeout].join(",")}</p>;`);
    expect(globals).toEqual({ type: "p", props: {}, children: ["undefined,undefined,function,undefined"] });
    await expect(runCard(compileCard(`export default () => { for (;;) {} };`), { data: {}, params: {}, size: "M" })).rejects.toThrow();
  });

  it("reports a card that does not export a component", async () => {
    await expect(runCard(compileCard(`const x = 1;`), { data: {}, params: {}, size: "M" })).rejects.toThrow("default function");
  });
});

describe("card tree checks", () => {
  const tree = (type: string, props: Record<string, unknown> = {}, children: unknown[] = []) => ({ type, props, children });
  it("refuses elements and attributes that could run code or load anything", () => {
    for (const bad of [tree("script"), tree("iframe"), tree("img", { src: "x" }), tree("a", { href: "https://x" }), tree("use", { href: "#a" }), tree("foreignObject"),
      tree("div", { onClick: "x" }), tree("div", { dangerouslySetInnerHTML: { __html: "<b>" } }), tree("div", { style: { background: "url(https://evil/?d=1)" } }),
      tree("rect", { fill: "url(https://evil)" }), tree("div", { style: { background: String.raw`u\72l(https://evil/?d=1)` } }), tree("rect", { fill: String.raw`\75rl(https://evil)` }),
      tree("div", { style: { background: 'image-set("https://evil/a.png" 1x)' } }), tree("kit:Unknown"), tree("kit:Chart", { type: "line", series: [{ name: "a", values: [1] }], tooltip: { formatter: "<img>" } }),
      tree("kit:Link", { to: { page: "https://evil" } }), tree("kit:Money", { minor: "1.5", currency: "EUR" })])
      expect(() => sanitizeTree(bad, { scope: "c1" }), JSON.stringify(bad)).toThrow(CardTreeError);
  });

  it("namespaces ids and their url(#id) references, and checks Kit tab panels too", () => {
    const checked = sanitizeTree(tree("svg", {}, [tree("defs", {}, [tree("linearGradient", { id: "g" })]), tree("rect", { fill: "url(#g)", width: 10 })]), { scope: "c1" });
    expect(JSON.stringify(checked)).toContain('"id":"c1-g"');
    expect(JSON.stringify(checked)).toContain('"fill":"url(#c1-g)"');
    expect(() => sanitizeTree(tree("kit:Tabs", { tabs: [{ label: "a", content: tree("script") }, { label: "b", content: "x" }] }), { scope: "c1" })).toThrow(CardTreeError);
  });

  it("scopes card CSS to the card, renames keyframes and drops anything that loads or escapes", () => {
    const css = scopeCss(String.raw`body{color:red} .hero{animation:pop 1s} @keyframes pop{from{opacity:0}} @import "x.css"; .bg{background:url(https://evil)} .e{background:u\72l("https://evil/e")} .f{background:\75rl("https://evil/f")} .g{background:image-set("https://evil/g" 1x)} @font-face{src:url(x)} p::after{content:"</style><script>"}`, "c1");
    expect(css).toContain('[data-card="c1"]{color:red}');
    expect(css).toContain('[data-card="c1"] .hero{animation:c1-pop 1s}');
    expect(css).toContain("@keyframes c1-pop");
    expect(css).not.toMatch(/@import|url\(|@font-face|<\/|evil/);
  });
});

describe("card params", () => {
  it("only ever uses a declared option, falling back to the default", () => {
    const declared = [{ kind: "choice" as const, name: "pick", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], default: "a" },
      { kind: "month" as const, name: "month", months: 3, default: "current" as const }, { kind: "period" as const, name: "range", options: ["30d" as const, "ytd" as const], default: "30d" as const }];
    const picked = resolveParams(declared, { pick: "b", month: "2026-09", range: "ytd" }, "2026-11-04");
    expect(picked.resolved).toEqual({ values: { pick: "b", month: "2026-09", range: "ytd" }, ranges: { month: { from: "2026-09-01", to: "2026-09-30" }, range: { from: "2026-01-01", to: "2026-11-04" } } });
    const forged = resolveParams(declared, { pick: "c", month: "2020-01", range: "999d" }, "2026-11-04");
    expect(forged.resolved.values).toEqual({ pick: "a", month: "2026-11", range: "30d" });
    expect(forged.resolved.ranges.month).toEqual({ from: "2026-11-01", to: "2026-11-04" });
    expect(forged.state[1].options.map(option => option.value)).toEqual(["2026-09", "2026-10", "2026-11"]);
    const lastMonth = resolveParams([{ kind: "month", name: "month", months: 12, default: "previous" }], {}, "2026-11-04");
    expect(lastMonth.resolved.ranges.month).toEqual({ from: "2026-10-01", to: "2026-10-31" });
  });
});

describe("presets", () => {
  it("each preset is our own code that renders a clean tree from data paths", async () => {
    const data = { month: { spent_formatted: "€1,240.00" }, cats: { rows: [{ name: "Food", total_formatted: "€400", total_minor: "40000", target_minor: "50000" }] } };
    const configs = {
      stat: { label: "Spent", value: "month.spent_formatted" },
      stat_row: { items: [{ label: "Spent", value: "month.spent_formatted" }, { label: "Again", value: "month.spent_formatted" }] },
      bar_list: { rows: "cats.rows", label: "name", value: "total_formatted", amount: "total_minor" },
      trend: { rows: "cats.rows", label: "name", amount: "total_minor" },
      progress: { rows: "cats.rows", label: "name", current: "total_minor", target: "target_minor" },
      list: { rows: "cats.rows", primary: "name", trailing: "total_formatted" },
    };
    for (const name of Object.keys(PRESETS) as (keyof typeof PRESETS)[]) {
      const tree = await render(presetSource(name, configs[name]), data, {}, "S");
      expect(JSON.stringify(tree), name).toMatch(/€1,240\.00|Food/);
    }
    expect(() => presetSource("stat", { label: "x", value: "a;b" })).toThrow();
  });
});
