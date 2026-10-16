import Link from "next/link";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { calendarDate } from "@/lib/finance/calendar";
import { formatMoney } from "@/lib/finance/format";
import { loadInvestigationEntities, runInvestigation } from "@/lib/finance/investigation-reader";
import type { InvestigationSpec } from "@/lib/finance/investigation";
import { kindLabel, statusLabel } from "../transactions/labels";
import { parseInvestigationParams } from "./input";

const field = "min-h-9 w-full rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm";
const destination = (spec: InvestigationSpec) => `/money/investigations?${new URLSearchParams({ query: JSON.stringify(spec) })}`;
const METRICS: Record<string, string> = { spending: "Spending", income: "Income", net: "Net (in minus out)", signed: "Signed total", absolute: "Total movement", count: "Number of transactions" };
const SORTS: Record<string, string> = { "absolute-delta-desc": "Biggest change", "delta-desc": "Largest increase", "delta-asc": "Largest decrease", "current-desc": "Highest this period", "current-asc": "Lowest this period", key: "Name" };
const DIMENSIONS: Record<string, string> = { account: "Account", category: "Category", merchant: "Merchant", tag: "Tag", event: "Trip / event", date: "Day", month: "Month", kind: "Type", status: "Status" };
const CLASSIFICATIONS: Record<string, string> = { resolved: "Reviewed transactions only", all: "Include ones still needing review (provisional)", unresolved: "Only ones needing review (provisional)" };

function shift(date: string, months: number) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCMonth(value.getUTCMonth() + months);
  return value.toISOString().slice(0, 10);
}
const endOfMonth = (date: string) => new Date(Date.parse(`${shift(`${date.slice(0, 7)}-01`, 1)}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

function Checks({ name, options, checked }: { name: string; options: Record<string, string>; checked: string[] }) {
  return <div className="flex flex-wrap gap-x-4 gap-y-1">{Object.entries(options).map(([value, label]) =>
    <label key={value} className="flex items-center gap-1.5 text-sm"><input type="checkbox" name={name} value={value} defaultChecked={checked.includes(value)} />{label}</label>)}</div>;
}

export default async function InvestigationPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { redirect("/login"); }
  const today = calendarDate(new Date(), context.workspace.timezone);
  const monthStart = `${today.slice(0, 7)}-01`;
  let spec: InvestigationSpec | undefined;
  let result: Awaited<ReturnType<typeof runInvestigation>> | undefined;
  let error: string | undefined;
  const [entities, params] = await Promise.all([loadInvestigationEntities(context), searchParams]);
  try {
    spec = parseInvestigationParams(params, { from: monthStart, to: today });
    result = await runInvestigation(spec, context);
    spec = { ...result.interpretedFilters, page: spec.page };
  } catch (e) { error = e instanceof Error ? e.message : "Investigation unavailable"; }
  const names = new Map([entities.accounts, entities.categories, entities.merchants].flat().map(e => [e.id, e.name]));
  const display = (key: string, value: unknown) => Array.isArray(value) ? value.join(", ") || "No tags" : value === null ? "Unassigned"
    : key === "kind" ? kindLabel(String(value)) : key === "status" ? statusLabel(String(value)) : names.get(String(value)) ?? String(value);
  const money = (amount: string | null, currency: string) => amount === null ? "—" : spec?.metric === "count" ? amount : formatMoney(amount, currency, context.workspace.locale);
  const lastMonth = shift(monthStart, -1);
  const presets = [
    { label: "This month vs last", from: monthStart, to: today, comparisonFrom: lastMonth, comparisonTo: endOfMonth(lastMonth) },
    { label: "Last month vs month before", from: lastMonth, to: endOfMonth(lastMonth), comparisonFrom: shift(monthStart, -2), comparisonTo: endOfMonth(shift(monthStart, -2)) },
    { label: "Last 3 months vs previous 3", from: shift(monthStart, -3), to: endOfMonth(lastMonth), comparisonFrom: shift(monthStart, -6), comparisonTo: endOfMonth(shift(monthStart, -4)) },
    { label: "This year vs last", from: `${today.slice(0, 4)}-01-01`, to: today, comparisonFrom: `${Number(today.slice(0, 4)) - 1}-01-01`, comparisonTo: shift(today, -12) },
  ];
  return <main className="mx-auto w-full max-w-6xl space-y-6 px-4 py-8 sm:px-8 lg:py-10">
    <header><nav className="flex gap-4 text-sm text-muted-foreground"><Link className="hover:text-foreground" href="/money/transactions">Transactions</Link><Link className="hover:text-foreground" href="/money/accounts">Accounts</Link><Link className="hover:text-foreground" href="/money/recurring">Recurring</Link></nav>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight sm:text-3xl">Investigate your money</h1><p className="mt-2 text-sm text-muted-foreground">Compare two periods, see what changed, then open the transactions behind each change.</p></header>
    <nav aria-label="Quick comparisons" className="flex flex-wrap gap-2">{presets.map(preset => {
      const { label, ...dates } = preset;
      return <Link key={label} href={`/money/investigations?${new URLSearchParams({ ...dates, groupBy: "category" })}`} className="rounded-full border border-border bg-card px-3 py-1.5 text-sm hover:bg-muted">{label}</Link>;
    })}</nav>
    <form className="space-y-5 rounded-xl border border-border bg-card p-5" action="/money/investigations" method="get" aria-label="Investigation filters">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="grid gap-1 text-sm">From<input className={field} type="date" name="from" required defaultValue={spec?.period.from ?? monthStart} /></label>
        <label className="grid gap-1 text-sm">To<input className={field} type="date" name="to" required defaultValue={spec?.period.to ?? today} /></label>
        <label className="grid gap-1 text-sm">Compare with: from<input className={field} type="date" name="comparisonFrom" defaultValue={spec?.comparison?.from} /></label>
        <label className="grid gap-1 text-sm">Compare with: to<input className={field} type="date" name="comparisonTo" defaultValue={spec?.comparison?.to} /></label>
        <label className="grid gap-1 text-sm">Measure<select className={field} name="metric" defaultValue={spec?.metric ?? "spending"}>{Object.entries(METRICS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="grid gap-1 text-sm">Sort results by<select className={field} name="sort" defaultValue={spec?.sort ?? "absolute-delta-desc"}>{Object.entries(SORTS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label className="grid gap-1 text-sm">Currencies<select className={field} name="currencyMode" defaultValue={spec?.currencyPolicy.mode ?? "original"}><option value="original">Keep each currency separate</option><option value="base">Convert to one currency</option></select></label>
        <label className="grid gap-1 text-sm">Currency code<input className={field} name="currency" placeholder="e.g. EUR" pattern="[A-Z]{3}" maxLength={3} defaultValue={spec?.currencyPolicy.mode === "base" ? spec.currencyPolicy.currency : spec?.currencyPolicy.currencies?.[0]} /></label>
      </div>
      <fieldset className="space-y-2"><legend className="text-sm font-medium">Break down by</legend><Checks name="groupBy" options={DIMENSIONS} checked={spec?.groupBy ?? []} /></fieldset>
      <details className="space-y-4" open={Boolean(spec && (["accounts", "categories", "merchants", "tags", "events"] as const).some(key => spec![key]?.include?.length || spec![key]?.exclude?.length))}>
        <summary className="cursor-pointer text-sm font-medium">Narrow down (accounts, categories, merchants, tags)</summary>
        <div className="mt-3 grid gap-4 sm:grid-cols-3">{(["accounts", "categories", "merchants"] as const).map(key => <fieldset key={key} className="space-y-2"><legend className="text-sm font-medium capitalize">{key}</legend>{(["include", "exclude"] as const).map(operation =>
          <label key={operation} className="grid gap-1 text-xs text-muted-foreground">{operation === "include" ? "Only these (empty means all)" : "Leave out"}<select multiple size={4} className={field} name={operation === "include" ? key : `exclude${key}`} defaultValue={spec?.[key]?.[operation]?.flatMap(ref => "id" in ref ? [ref.id] : [])}>{entities[key].map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select></label>)}</fieldset>)}</div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{(["tags", "events"] as const).flatMap(key => (["include", "exclude"] as const).map(operation => <label key={`${key}${operation}`} className="grid gap-1 text-sm">{operation === "include" ? "Only" : "Leave out"} {key === "tags" ? "tags" : "trips / events"}<input className={field} name={operation === "include" ? key : `exclude${key[0].toUpperCase()}${key.slice(1)}`} placeholder="Comma separated" defaultValue={spec?.[key]?.[operation]?.join(", ")} /></label>))}</div>
        <div className="mt-3 grid gap-4 sm:grid-cols-3">
          <fieldset className="space-y-2"><legend className="text-sm font-medium">Status</legend><Checks name="statuses" options={{ posted: "Posted", pending: "Pending" }} checked={spec?.statuses ?? ["posted"]} /></fieldset>
          <fieldset className="space-y-2"><legend className="text-sm font-medium">Types</legend><Checks name="kinds" options={{ ordinary: "Regular", refund: "Refund", transfer: "Transfer" }} checked={spec?.kinds ?? ["ordinary", "refund"]} /></fieldset>
          <label className="grid gap-1 text-sm">Review state<select className={field} name="classifications" defaultValue={spec?.classifications ?? "resolved"}>{Object.entries(CLASSIFICATIONS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        </div>
      </details>
      <button className="min-h-9 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">Run investigation</button>
    </form>
    {error ? <p role="alert" className="rounded-xl border border-border bg-card p-6 text-sm">{error}</p> : null}
    {result && spec ? <>
      <section className="space-y-2 rounded-xl border border-border bg-card p-5 text-sm" aria-label="Interpreted scope"><h2 className="text-base font-semibold">What this covers</h2>
        <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">Period</dt><dd>{spec.period.from} to {spec.period.to}{spec.comparison ? `, compared with ${spec.comparison.from} to ${spec.comparison.to}` : ""}</dd>
          <dt className="text-muted-foreground">Measure</dt><dd>{METRICS[spec.metric] ?? spec.metric}</dd>
          <dt className="text-muted-foreground">Includes</dt><dd>{spec.statuses.map(statusLabel).join(", ")} · {spec.kinds.map(kindLabel).join(", ")} · {CLASSIFICATIONS[spec.classifications] ?? spec.classifications}</dd>
          {(["accounts", "categories", "merchants", "tags", "events"] as const).flatMap(key => (["include", "exclude"] as const).map(operation => {
            const values = spec![key]?.[operation];
            return values?.length ? [<dt key={`${key}${operation}t`} className="text-muted-foreground">{operation === "include" ? "Only" : "Leaving out"} {key}</dt>, <dd key={`${key}${operation}d`}>{values.map(v => typeof v === "string" ? v : "id" in v ? names.get(v.id) ?? v.id : v.name).join(", ")}</dd>] : [];
          }))}
          <dt className="text-muted-foreground">Records</dt><dd>{result.coverage.includedRows} included{result.coverage.unresolvedIncluded ? `, ${result.coverage.unresolvedIncluded} provisional` : ""}{result.coverage.classificationExcluded ? `; ${result.coverage.classificationExcluded} left out pending review` : ""}{result.coverage.statusExcluded ? `; ${result.coverage.statusExcluded} left out by status` : ""}{result.coverage.kindExcluded ? `; ${result.coverage.kindExcluded} left out by type` : ""}</dd>
        </dl>
        <p className="text-muted-foreground">{spec.currencyPolicy.mode === "original" ? "Each currency is shown separately." : `Amounts are converted to ${spec.currencyPolicy.currency} using the exchange rate on each posting date; totals stay unavailable if a rate is missing.`} Refunds reduce spending. {result.coverage.limitation}</p>
        <p className="text-xs text-muted-foreground">Data as of {result.evidence.capturedAt}.</p>
      </section>
      <section className="overflow-x-auto rounded-xl border border-border bg-card" aria-label="Comparison results"><table className="w-full text-sm"><thead className="sticky top-0 border-b border-border bg-muted text-left text-xs text-muted-foreground"><tr><th className="p-3 font-medium">Group</th><th className="p-3 text-right font-medium">This period</th><th className="p-3 text-right font-medium">Comparison</th><th className="p-3 text-right font-medium">Change</th><th className="p-3 font-medium">Transactions</th></tr></thead><tbody>{result.groups.map(g => <tr className="border-b border-border last:border-0" key={g.key}><td className="p-3">{Object.entries(g.dimensions).map(([key, value]) => `${DIMENSIONS[key] ?? key}: ${display(key, value)}`).join(" · ") || "All transactions"}<span className="ml-2 text-xs text-muted-foreground">{g.currency}</span></td><td className="p-3 text-right font-mono tabular-nums">{money(g.currentMinor, g.currency)}</td><td className="p-3 text-right font-mono tabular-nums">{money(g.comparisonMinor, g.currency)}</td><td className="p-3 text-right font-mono tabular-nums">{money(g.deltaMinor, g.currency)}</td><td className="p-3"><Link className="underline" href={destination({ ...spec!, page: { size: 25, period: "both", groupKey: g.key } })}>Open records ({g.supportCount})</Link></td></tr>)}</tbody></table>{!result.groups.length ? <p className="p-6 text-center text-sm text-muted-foreground">No transactions match these filters.</p> : null}</section>
      <section className="space-y-3" aria-label="Supporting records"><div className="flex items-baseline justify-between"><h2 className="text-base font-semibold">Supporting records ({result.records.total})</h2>{spec.page.groupKey ? <Link className="text-sm underline" href={destination({ ...spec, page: { size: 25, period: "both" } })}>All matching records</Link> : null}</div>
        <div className="overflow-x-auto rounded-xl border border-border bg-card"><table className="w-full text-sm"><thead className="border-b border-border bg-muted text-left text-xs text-muted-foreground"><tr><th className="p-3 font-medium">Date</th><th className="p-3 font-medium">Transaction</th><th className="p-3 font-medium">Type</th><th className="p-3 text-right font-medium">Amount</th></tr></thead><tbody>{result.records.items.map(r => <tr key={r.id} className="border-b border-border last:border-0"><td className="p-3 font-mono">{r.date}<span className="block font-sans text-xs text-muted-foreground">{r.current ? "This period" : ""}{r.current && r.comparison ? " / " : ""}{r.comparison ? "Comparison" : ""}</span></td><td className="p-3"><Link className="underline" href={r.link}>{r.description}</Link><span className="block text-xs text-muted-foreground">{names.get(r.accountId)} · {display("category", r.categoryId)}{r.tags.length ? ` · ${r.tags.join(", ")}` : ""}{r.event ? ` · ${r.event}` : ""}</span></td><td className="p-3">{statusLabel(r.status)} · {kindLabel(r.kind)}{r.reviewReasons.length ? <span className="block text-xs text-amber-700 dark:text-amber-300">Needs review</span> : null}</td><td className="p-3 text-right font-mono tabular-nums">{formatMoney(r.amountMinor, r.currency, context.workspace.locale)}</td></tr>)}</tbody></table></div>
        {result.records.nextCursor ? <Link className="inline-block rounded-md border border-border px-4 py-2 text-sm" href={destination({ ...spec, page: { ...spec.page, cursor: result.records.nextCursor } })}>Next supporting records</Link> : null}
      </section>
    </> : null}
  </main>;
}
