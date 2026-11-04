import { ForecastChart } from "@/components/chart";
import type { ForecastEvent, forecastDaily } from "@/lib/finance/calculations";
import { formatInputAmount, formatMoney } from "@/lib/finance/format";

type Days = Extract<ReturnType<typeof forecastDaily>, { status: "available" }>["days"];
const major = (amount: bigint, currency: string) => Number(formatInputAmount(amount, currency));

/** Outgoing dated payments inside the forecast window, soonest first. */
function upcomingObligations(events: ForecastEvent[], days: Days) {
  const window = new Set(days.map(day => day.date));
  return events.filter(event => event.expectedMinor < 0n && window.has(event.date)).sort((a, b) => a.date.localeCompare(b.date));
}

export function ForecastView({ days, events, currency, locale, names, compare }: {
  days: Days; events: ForecastEvent[]; currency: string; locale?: string; names: Map<string, string>; compare?: { name: string; days: Days };
}) {
  const obligations = upcomingObligations(events, days);
  const money = (amount: bigint) => formatMoney(amount, currency, locale);
  const last = days.at(-1)!;
  const payment = (event: ForecastEvent, index: number) => <li key={index} className="flex flex-wrap items-baseline justify-between gap-2 px-3 py-2"><span><span className="font-mono text-muted-foreground">{event.date}</span> · {event.name ?? "Forecast movement"} · {names.get(event.accountId) ?? "Account"}{event.source === "scenario" ? " · what-if" : ""}</span><span className="font-mono">{money(event.expectedMinor)}</span></li>;
  return <div className="space-y-4">
    <ForecastChart currency={currency}
      label={`Expected balance with a conservative to optimistic band from ${days[0].date} to ${last.date}; dots mark upcoming payments`}
      days={days.map(day => ({ date: day.date, expected: major(day.expectedMinor, currency), conservative: major(day.conservativeMinor, currency), optimistic: major(day.optimisticMinor, currency) }))}
      obligations={obligations.map(event => ({ date: event.date, name: event.name ?? "Payment", amount: money(event.expectedMinor) }))}
      compare={compare && { name: compare.name, values: compare.days.map(day => major(day.expectedMinor, currency)) }} />
    <p className="text-xs text-muted-foreground">Shaded band runs from conservative to optimistic. Chart coordinates are approximate; exact amounts appear below.</p>
    <dl className="grid gap-3 sm:grid-cols-3">{([["Expected", last.expectedMinor], ["Conservative", last.conservativeMinor], ["Optimistic", last.optimisticMinor]] as const).map(([label, amount]) =>
      <div key={label} className="rounded-lg bg-muted/60 px-4 py-3"><dt className="text-xs text-muted-foreground">{label} at horizon</dt><dd className="mt-1 font-mono text-base font-semibold">{money(amount)}</dd></div>)}</dl>
    <div><h3 className="text-sm font-semibold">Upcoming obligations</h3>
      {obligations.length ? <ul className="mt-2 divide-y divide-border rounded-lg border border-border text-sm">{obligations.slice(0, 8).map(payment)}</ul>
        : <p className="mt-1 text-sm text-muted-foreground">No outgoing payments in this horizon.</p>}
      {obligations.length > 8 && <details className="mt-2"><summary className="min-h-11 cursor-pointer content-center text-sm underline">Show {obligations.length - 8} more payments</summary><ul className="mt-2 divide-y divide-border rounded-lg border border-border text-sm">{obligations.slice(8).map(payment)}</ul></details>}
    </div>
    <details><summary className="min-h-11 cursor-pointer content-center text-sm underline">Daily forecast table</summary>
      <div className="mt-2 overflow-x-auto"><table className="w-full text-sm"><caption className="sr-only">Expected, conservative and optimistic balance for each day</caption>
        <thead><tr className="border-b border-border text-left text-xs text-muted-foreground"><th scope="col" className="py-2 pr-4 font-medium">Date</th><th scope="col" className="py-2 pr-4 font-medium">Expected</th><th scope="col" className="py-2 pr-4 font-medium">Conservative</th><th scope="col" className="py-2 font-medium">Optimistic</th></tr></thead>
        <tbody>{days.map(day => <tr key={day.date} className="border-b border-border last:border-0 font-mono"><th scope="row" className="py-1.5 pr-4 text-left font-normal">{day.date}</th><td className="py-1.5 pr-4">{money(day.expectedMinor)}</td><td className="py-1.5 pr-4">{money(day.conservativeMinor)}</td><td className="py-1.5">{money(day.optimisticMinor)}</td></tr>)}</tbody>
      </table></div>
    </details>
  </div>;
}
