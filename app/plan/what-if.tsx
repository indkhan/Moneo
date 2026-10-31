import Link from "next/link";
import { formatMoney } from "@/lib/finance/format";
import type { evaluatePlan } from "@/lib/finance/model";
import { addScenarioEvent, createScenario } from "./actions";
import { ScenarioEditor } from "./scenarios";
import { button, cadenceLabels, card, eyebrow, field } from "./ui";

type Projection = Pick<Awaited<ReturnType<typeof evaluatePlan>>, "forecast" | "available">;
type Scenario = { id: string; name: string; description: string | null; version: number };

function figures(plan: Projection) {
  const last = plan.forecast.status === "available" ? plan.forecast.days.at(-1) : undefined;
  return {
    headroom: plan.available.status === "available" ? plan.available.amountMinor : null,
    tightest: plan.available.status === "available" ? plan.available.limitingDate : null,
    expected: last?.expectedMinor ?? null,
    conservative: last?.conservativeMinor ?? null,
  };
}

function Comparison({ real, scenario, name, currency, locale, horizon }: { real: Projection; scenario: Projection; name: string; currency: string; locale?: string; horizon: number }) {
  const a = figures(real), b = figures(scenario);
  const money = (value: bigint | null) => value === null ? "Unavailable" : formatMoney(value, currency, locale);
  const delta = (x: bigint | null, y: bigint | null) => x === null || y === null ? "—" : `${y - x > 0n ? "+" : ""}${formatMoney(y - x, currency, locale)}`;
  const rows: [string, string, string, string][] = [
    ["Lowest headroom", money(a.headroom), money(b.headroom), delta(a.headroom, b.headroom)],
    ["Tightest day", a.tightest ?? "Unavailable", b.tightest ?? "Unavailable", ""],
    ["Expected at horizon", money(a.expected), money(b.expected), delta(a.expected, b.expected)],
    ["Conservative at horizon", money(a.conservative), money(b.conservative), delta(a.conservative, b.conservative)],
  ];
  return <div className="space-y-2">
    <div className="overflow-x-auto"><table className="w-full min-w-[28rem] text-sm"><caption className="sr-only">Real plan compared with {name}</caption>
      <thead><tr className="border-b border-border text-left text-xs text-muted-foreground"><th scope="col" className="py-2 font-medium" /><th scope="col" className="py-2 font-medium">Real plan</th><th scope="col" className="py-2 font-medium">{name}</th><th scope="col" className="py-2 font-medium">Difference</th></tr></thead>
      <tbody>{rows.map(([label, x, y, d]) => <tr key={label} className="border-b border-border last:border-0"><th scope="row" className="py-2 text-left font-medium">{label}</th><td className="py-2 font-mono">{x}</td><td className="py-2 font-mono">{y}</td><td className="py-2 font-mono">{d}</td></tr>)}</tbody>
    </table></div>
    <p className="text-sm">{a.headroom !== null && b.headroom !== null ? `Compared with the real plan: ${formatMoney(b.headroom - a.headroom, currency, locale)} change in spare cash over ${horizon} days.` : "Comparison unavailable until both forecasts have complete inputs."} Your real accounts are unchanged.</p>
  </div>;
}

export function WhatIfSection({ scenarios, selected, href, real, scenario, accounts, currency, locale, today, horizon }: {
  scenarios: Scenario[]; selected?: Scenario; href: (id?: string) => string; real: Projection; scenario: Projection;
  accounts: { id: string; name: string }[]; currency: string; locale?: string; today: string; horizon: number;
}) {
  const tab = (active: boolean) => `inline-flex h-11 items-center rounded-[10px] border px-3.5 lg:h-[38px] text-[13px] font-medium ${active ? "border-foreground bg-foreground text-background" : "border-input text-muted-foreground hover:text-foreground"}`;
  return <section id="what-if" className={`${card} scroll-mt-24`} aria-labelledby="what-if-heading">
    <div><p className={eyebrow}>What if</p><h2 id="what-if-heading" className="mt-1 text-sm font-medium">What-if scenarios</h2><p className="mt-1 text-sm text-muted-foreground">Try a change side by side with your real plan. Nothing here touches real accounts.</p></div>
    <nav aria-label="Scenarios" className="flex flex-wrap gap-2"><Link href={href()} className={tab(!selected)}>Real plan</Link>{scenarios.map(item => <Link key={item.id} href={href(item.id)} className={tab(item.id === selected?.id)}>{item.name}</Link>)}</nav>
    {selected ? <>
      <Comparison real={real} scenario={scenario} name={selected.name} currency={currency} locale={locale} horizon={horizon} />
      <ScenarioEditor scenario={selected} />
      <form action={addScenarioEvent} className="flex flex-wrap gap-3 rounded-[14px] border border-dashed border-input p-4"><input type="hidden" name="scenarioId" value={selected.id} /><input name="name" required aria-label="Hypothetical event name" placeholder="Laptop, raise…" className={field} /><input name="amount" required inputMode="decimal" aria-label="Hypothetical change amount" placeholder="-1200.00" className={field} /><select name="accountId" aria-label="Account" className={field}>{accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select><select name="cadence" aria-label="Cadence" className={field}>{(["once", "monthly", "quarterly", "weekly", "biweekly", "yearly"] as const).map(value => <option key={value} value={value}>{cadenceLabels[value]}</option>)}</select><input type="date" name="startsOn" defaultValue={today} required aria-label="Start date" className={field} /><button className={button}>Add hypothetical change</button></form>
    </> : scenarios.length ? <p className="text-sm text-muted-foreground">Choose a scenario to compare it with the real plan.</p> : null}
    <form action={createScenario} className="flex flex-wrap gap-3"><input name="name" required maxLength={120} aria-label="New scenario name" placeholder="What if…" className={field} /><button className={button}>Create scenario</button></form>
  </section>;
}
