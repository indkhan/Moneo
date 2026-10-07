import Link from "next/link";
import { redirect } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { calendarDate } from "@/lib/finance/calendar";
import { formatMoney } from "@/lib/finance/format";
import { loadInvestigationEntities, runInvestigation } from "@/lib/finance/investigation-reader";
import type { InvestigationSpec } from "@/lib/finance/investigation";
import { parseInvestigationParams } from "./input";

const field = "rounded-md border bg-background px-3 py-2 text-sm";
const destination = (spec: InvestigationSpec) => `/money/investigations?${new URLSearchParams({ query: JSON.stringify(spec) })}`;

export default async function InvestigationPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { redirect("/login"); }
  const today = calendarDate(new Date(), context.workspace.timezone);
  const entities = await loadInvestigationEntities(context);
  let spec: InvestigationSpec | undefined;
  let result: Awaited<ReturnType<typeof runInvestigation>> | undefined;
  let error: string | undefined;
  try {
    spec = parseInvestigationParams(await searchParams, { from: `${today.slice(0, 7)}-01`, to: today });
    result = await runInvestigation(spec, context);
    spec = { ...result.interpretedFilters, page: spec.page };
  } catch (e) { error = e instanceof Error ? e.message : "Investigation unavailable"; }
  const names = new Map([entities.accounts, entities.categories, entities.merchants].flat().map(e => [e.id, e.name]));
  const display = (value: unknown) => Array.isArray(value) ? value.join(", ") || "No tags" : value === null ? "Unassigned" : names.get(String(value)) ?? String(value);
  const money = (amount: string | null, currency: string) => amount === null ? "—" : spec?.metric === "count" ? amount : formatMoney(amount, currency, context.workspace.locale);
  return <main className="mx-auto max-w-6xl space-y-6 p-6">
    <header className="space-y-2"><nav className="flex gap-4 text-sm"><Link href="/money/transactions">Transactions</Link><Link href="/money/accounts">Accounts</Link><Link href="/money/recurring">Recurring</Link></nav>
      <h1 className="text-2xl font-semibold">Investigate your money</h1><p className="text-sm text-muted-foreground">Choose the exact scope, compare periods, then open the records behind each change.</p></header>
    <form className="space-y-4 rounded-xl border p-4" action="/money/investigations" method="get" aria-label="Investigation filters">
      <div className="flex flex-wrap gap-3">
        <label className="grid gap-1 text-sm">From<input className={field} type="date" name="from" required defaultValue={spec?.period.from ?? `${today.slice(0, 7)}-01`} /></label>
        <label className="grid gap-1 text-sm">To<input className={field} type="date" name="to" required defaultValue={spec?.period.to ?? today} /></label>
        <label className="grid gap-1 text-sm">Compare from<input className={field} type="date" name="comparisonFrom" defaultValue={spec?.comparison?.from} /></label>
        <label className="grid gap-1 text-sm">Compare to<input className={field} type="date" name="comparisonTo" defaultValue={spec?.comparison?.to} /></label>
        <label className="grid gap-1 text-sm">Measure<select className={field} name="metric" defaultValue={spec?.metric ?? "spending"}>{["spending", "income", "net", "signed", "absolute", "count"].map(m => <option key={m}>{m}</option>)}</select></label>
        <label className="grid gap-1 text-sm">Currency policy<select className={field} name="currencyMode" defaultValue={spec?.currencyPolicy.mode ?? "original"}><option value="original">Original, kept separate</option><option value="base">Base, dated conversion</option></select></label>
        <label className="grid gap-1 text-sm">Currency<input className={field} name="currency" placeholder="All originals / required base" pattern="[A-Z]{3}" maxLength={3} defaultValue={spec?.currencyPolicy.mode === "base" ? spec.currencyPolicy.currency : spec?.currencyPolicy.currencies?.[0]} /></label>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">{(["accounts", "categories", "merchants"] as const).map(key => <fieldset key={key} className="space-y-2"><legend className="text-sm font-medium capitalize">{key}</legend>{(["include", "exclude"] as const).map(operation => <label key={operation} className="grid gap-1 text-sm"><span>{operation === "include" ? "Include (empty means all)" : "Exclude"}</span><select multiple className={field} name={operation === "include" ? key : `exclude${key}`} defaultValue={spec?.[key]?.[operation]?.flatMap(ref => "id" in ref ? [ref.id] : [])}>{entities[key].map(e => <option key={e.id} value={e.id}>{e.name}</option>)}</select></label>)}</fieldset>)}</div>
      <div className="grid gap-3 sm:grid-cols-4">{(["tags", "events"] as const).flatMap(key => (["include", "exclude"] as const).map(operation => <label key={`${key}${operation}`} className="grid gap-1 text-sm">{operation} {key}<input className={field} name={operation === "include" ? key : `exclude${key[0].toUpperCase()}${key.slice(1)}`} placeholder="Comma separated" defaultValue={spec?.[key]?.[operation]?.join(", ")} /></label>))}</div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-sm">Group by<select multiple className={field} name="groupBy" defaultValue={spec?.groupBy ?? []}>{["account", "category", "merchant", "tag", "event", "date", "month", "kind", "status"].map(d => <option key={d}>{d}</option>)}</select></label>
        <label className="grid gap-1 text-sm">Status<select multiple className={field} name="statuses" defaultValue={spec?.statuses ?? ["posted"]}><option>posted</option><option>pending</option></select></label>
        <label className="grid gap-1 text-sm">Kinds<select multiple className={field} name="kinds" defaultValue={spec?.kinds ?? ["ordinary", "refund"]}><option>ordinary</option><option>refund</option><option>transfer</option></select></label>
        <label className="grid gap-1 text-sm">Classification<select className={field} name="classifications" defaultValue={spec?.classifications ?? "resolved"}><option value="resolved">Resolved only</option><option value="all">Include unresolved (provisional)</option><option value="unresolved">Unresolved only (provisional)</option></select></label>
        <label className="grid gap-1 text-sm">Sort<select className={field} name="sort" defaultValue={spec?.sort ?? "absolute-delta-desc"}>{["absolute-delta-desc", "delta-desc", "delta-asc", "current-desc", "current-asc", "key"].map(s => <option key={s}>{s}</option>)}</select></label>
        <button className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground">Run investigation</button>
      </div>
    </form>
    {error ? <p role="alert" className="rounded-lg border p-4">{error}</p> : null}
    {result && spec ? <>
      <section className="space-y-2 rounded-xl border p-4" aria-label="Interpreted scope"><h2 className="font-semibold">Interpreted scope</h2>
        <p className="text-sm">{spec.period.from} through {spec.period.to}{spec.comparison ? ` compared with ${spec.comparison.from} through ${spec.comparison.to}` : ""} · {spec.metric} · {spec.statuses.join(", ")} · {spec.kinds.join(", ")} · {spec.classifications} classifications.</p>
        <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm">{(["accounts", "categories", "merchants", "tags", "events"] as const).flatMap(key => (["include", "exclude"] as const).map(operation => {
          const values = spec![key]?.[operation];
          return values?.length ? <li key={`${key}${operation}`}>{operation} {key}: {values.map(v => typeof v === "string" ? v : "id" in v ? names.get(v.id) ?? v.id : v.name).join(", ")}</li> : null;
        }))}</ul>
        <p className="text-sm text-muted-foreground">{spec.currencyPolicy.mode === "original" ? "Original currencies stay separate." : `Base ${spec.currencyPolicy.currency} uses direct exact posting-date rates and rounds each canonical posting once; largest remainder allocation conserves totals across split groups. Missing rates leave totals unavailable.`} Refunds reduce spending; effective splits replace their parent and transfer fees remain ordinary spending. Transfer principals contribute only to signed, absolute and count measures. Tag grouping partitions by the complete tag set.</p>
        <p className="text-sm">{result.coverage.includedRows} included effective records; {result.coverage.classificationExcluded} classification exclusions; {result.coverage.unresolvedIncluded} provisional records; {result.coverage.pendingExcluded} status exclusions; {result.coverage.transferExcluded} kind exclusions.</p>
        <p className="text-sm text-muted-foreground">{result.coverage.limitation}</p><p className="text-xs text-muted-foreground">Live evidence captured {result.evidence.capturedAt}; query {result.queryId.slice(0, 12)}; evidence {result.evidenceId.slice(0, 12)}.</p>
      </section>
      <section className="overflow-x-auto rounded-xl border" aria-label="Comparison results"><table className="w-full text-sm"><thead className="border-b bg-muted/40 text-left"><tr><th className="p-3">Group</th><th className="p-3">Current</th><th className="p-3">Comparison</th><th className="p-3">Change</th><th className="p-3">Evidence</th></tr></thead><tbody>{result.groups.map(g => <tr className="border-b last:border-0" key={g.key}><td className="p-3">{Object.entries(g.dimensions).map(([key, value]) => `${key}: ${display(value)}`).join(" · ") || "All records"}<span className="ml-2 text-muted-foreground">{g.currency}</span></td><td className="p-3 font-mono tabular-nums">{money(g.currentMinor, g.currency)}</td><td className="p-3 font-mono tabular-nums">{money(g.comparisonMinor, g.currency)}</td><td className="p-3 font-mono tabular-nums">{money(g.deltaMinor, g.currency)}</td><td className="p-3"><Link className="underline" href={destination({ ...spec!, page: { size: 25, period: "both", groupKey: g.key } })}>Open records ({g.currentCount + g.comparisonCount})</Link></td></tr>)}</tbody></table>{!result.groups.length ? <p className="p-4 text-sm">No records match this scope.</p> : null}</section>
      <section className="space-y-3" aria-label="Supporting records"><div className="flex items-baseline justify-between"><h2 className="text-lg font-semibold">Supporting records ({result.records.total})</h2>{spec.page.groupKey ? <Link className="text-sm underline" href={destination({ ...spec, page: { size: 25, period: "both" } })}>All matching records</Link> : null}</div>
        <div className="overflow-x-auto rounded-xl border"><table className="w-full text-sm"><thead className="border-b text-left"><tr><th className="p-3">Date / period</th><th className="p-3">Record</th><th className="p-3">Classification</th><th className="p-3">Amount</th></tr></thead><tbody>{result.records.items.map(r => <tr key={r.id} className="border-b last:border-0"><td className="p-3">{r.date}<span className="block text-xs text-muted-foreground">{r.current ? "Current" : ""}{r.current && r.comparison ? " / " : ""}{r.comparison ? "Comparison" : ""}</span></td><td className="p-3"><Link className="underline" href={r.link}>{r.description}</Link><span className="block text-xs text-muted-foreground">{names.get(r.accountId)} · {display(r.categoryId)} · {r.tags.join(", ")}{r.event ? ` · ${r.event}` : ""}</span></td><td className="p-3">{r.status} · {r.kind}{r.reviewReasons.length ? <span className="block">Unresolved: {r.reviewReasons.join(", ")}</span> : null}</td><td className="p-3 font-mono tabular-nums">{formatMoney(r.amountMinor, r.currency, context.workspace.locale)}</td></tr>)}</tbody></table></div>
        {result.records.nextCursor ? <Link className="inline-block rounded-md border px-4 py-2 text-sm" href={destination({ ...spec, page: { ...spec.page, cursor: result.records.nextCursor } })}>Next supporting records</Link> : null}
      </section>
    </> : null}
  </main>;
}
