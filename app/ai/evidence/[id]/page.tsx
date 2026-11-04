import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { readEvidenceView } from "@/lib/finance/evidence-view";
import { formatMoney } from "@/lib/finance/format";
import { financialMetricHref, financialQualificationText } from "@/lib/finance/evidence-receipts";

export const metadata = { title: "Evidence" };

// Date-only financial periods are calendar days, so they are shown in UTC to keep their boundaries.
const day = (value: string, locale?: string) => { const date = new Date(`${value.slice(0, 10)}T00:00:00Z`); return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString(locale, { timeZone: "UTC", dateStyle: "medium" }); };
/** The recognisable part of a retained record; never guesses at what is not there. */
function recordSummary(record: unknown, locale?: string) {
  if (!record || typeof record !== "object") return "";
  const fields = record as Record<string, unknown>;
  const text = (...names: string[]) => names.map(name => fields[name]).find((value): value is string => typeof value === "string" && !!value);
  const minor = fields.amount_minor ?? fields.amountMinor, currency = text("currency_code", "currency", "currencyCode");
  const money = currency && (typeof minor === "string" || typeof minor === "number") && /^-?\d+$/.test(String(minor)) ? formatMoney(String(minor), currency, locale) : "";
  const date = text("posted_on", "postedOn", "date");
  return [text("description", "name", "title", "label"), date && day(date, locale), money].filter(Boolean).join(" · ");
}
const EVIDENCE_RETURN = /^\/ai\/activity\/[0-9a-f-]{36}$/i;
export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ metric?: string; sourcePage?: string; metricPage?: string; q?: string; from?: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { redirect("/login"); }
  const { id } = await params, query = await searchParams;
  const parsed = z.object({ id: z.uuid(), metric: z.string().min(1).max(200).optional(), sourcePage: z.coerce.number().int().min(0).max(1000).default(0), metricPage: z.coerce.number().int().min(0).max(40).default(0), q: z.string().trim().max(100).optional(), from: z.string().regex(EVIDENCE_RETURN).optional().catch(undefined) }).safeParse({ id, ...query });
  if (!parsed.success) notFound();
  const { locale, timezone } = context.workspace;
  const back = parsed.data.from ? { href: parsed.data.from, label: "← Back to the review" } : { href: "/ai/activity?filter=analyses", label: "← AI review history" };
  // A receipt that is missing, foreign or asks for an unknown measure stays a plain 404, so it reveals nothing.
  const failed = await readEvidenceView(context, id, parsed.data.metric).then(view => ({ view, failure: null }), (cause: unknown) => {
    const message = cause instanceof Error ? cause.message : "";
    return { view: null, failure: /mismatch|Metric unavailable/.test(message) ? null : /^AI access to /.test(message) ? "scope" as const : "service" as const };
  });
  const { view, failure } = failed;
  if (failure) return <main className="mx-auto max-w-5xl space-y-4 px-5 py-8 lg:px-8"><Link href={back.href} className="text-sm underline">{back.label}</Link><h1 className="page-title">Evidence unavailable</h1>
    {failure === "scope" ? <p role="alert">This evidence uses data Moneo&apos;s AI can no longer read. <Link href="/settings" className="underline">Review AI access in Settings</Link>.</p>
      : <p role="alert">Could not load this evidence just now. <Link href={`/ai/evidence/${id}`} className="underline">Try again</Link></p>}</main>;
  if (!view) notFound();
  const { receipt, metric, freshness, supportingRecords: allRecords } = view;
  const q = parsed.data.q?.toLowerCase();
  const supportingRecords = q ? allRecords.filter(source => `${source.type} ${JSON.stringify(source.record)}`.toLowerCase().includes(q)) : allRecords;
  const sourceOffset = parsed.data.sourcePage * 25, metricOffset = parsed.data.metricPage * 50;
  const visible = supportingRecords.slice(sourceOffset, sourceOffset + 25);
  const raw = (value: unknown) => JSON.stringify(value, null, 2);
  const amount = (item: typeof receipt.metrics[number]) => item.valueMinor === null ? "Unavailable" : item.unit === "count" ? `${item.valueMinor} records (${item.currency} scope)` : formatMoney(item.valueMinor, item.currency);
  // Each list keeps the other's place, and the way back.
  const href = (extra: Record<string, string>) => `/ai/evidence/${id}?${new URLSearchParams({ ...(metric ? { metric: metric.id } : {}), ...(parsed.data.q ? { q: parsed.data.q } : {}), ...(parsed.data.from ? { from: parsed.data.from } : {}), sourcePage: String(parsed.data.sourcePage), metricPage: String(parsed.data.metricPage), ...extra })}`;
  const metricCount = receipt.metrics.length;
  return <main className="mx-auto max-w-5xl space-y-6 px-5 py-8 lg:px-8">
    <Link href={back.href} className="text-sm underline">{back.label}</Link>
    <header><p className="eyebrow">Retained financial evidence</p><h1 className="mt-2 page-title">Calculation and supporting records</h1>
      <p className="mt-2 text-sm text-muted-foreground">Captured <time dateTime={receipt.fetchedAt}>{new Date(receipt.fetchedAt).toLocaleString(locale, { timeZone: timezone, dateStyle: "medium", timeStyle: "short" })}{timezone ? ` (${timezone})` : ""}</time> from {allRecords.length} {allRecords.length === 1 ? "record" : "records"}. This original dated result stays available when those records change.</p></header>
    <div role="status" className="rounded-lg border border-border bg-card p-4"><strong className="capitalize">Evidence {freshness.status}</strong><p className="mt-1 text-sm">{freshness.reason}</p>{freshness.status !== "current" && <p className="mt-1 text-sm">The result below is the original, dated one. <Link href="/ai" className="underline">Run a new review</Link> for a current figure.</p>}</div>
    {!!receipt.limitations?.length && <section aria-label="Limits of this evidence" className="rounded-lg border border-warning bg-warning-soft p-4"><h2 className="font-semibold">What this evidence cannot show</h2><ul className="mt-2 space-y-1 text-sm">{receipt.limitations.map(item => <li key={item.id}>{item.message}{item.nextStep === "supporting_records" ? <> <a href="#supporting-records" className="underline">See supporting records</a></> : <> <Link href="/plan" className="underline">Check your assumptions</Link></>}</li>)}</ul></section>}
    {metric ? <section className="rounded-lg border border-border bg-card p-5"><h2 className="text-lg font-semibold">{metric.label}</h2><p className="mt-3 text-xl font-semibold">{amount(metric)}</p>
      <p className="mt-2 text-sm">Period {day(metric.period.from, locale)} to {day(metric.period.to, locale)}</p>
      {!!metric.qualifiers.length && <p className="mt-2 text-sm">{metric.qualifiers.map(financialQualificationText).join(" ")}</p>}
      <h3 className="mt-4 font-medium">Actual calculation</h3><p className="mt-2 whitespace-pre-wrap break-words text-sm">{metric.calculation}</p>
      <Link href={`/ai/evidence/${id}`} className="mt-3 inline-block text-sm underline">All measures in this query</Link></section>
      : <section><h2 className="text-lg font-semibold">Measured results</h2><ul className="mt-3 space-y-2">{receipt.metrics.slice(metricOffset, metricOffset + 50).map(item => <li key={item.id}><Link href={financialMetricHref(id, item.id)} className="text-sm underline">{item.label}: {amount(item)} · {day(item.period.from, locale)} to {day(item.period.to, locale)}</Link>{item.qualifiers.length > 0 && <span className="ml-2 text-xs text-warning">Qualified</span>}</li>)}</ul>
        {metricCount > 50 && <p className="mt-3 flex flex-wrap gap-4 text-sm"><span className="text-muted-foreground">Showing {metricOffset + 1} to {Math.min(metricOffset + 50, metricCount)} of {metricCount}.</span>{parsed.data.metricPage > 0 && <Link href={href({ metricPage: String(parsed.data.metricPage - 1) })} className="underline">Previous measured results</Link>}{metricOffset + 50 < metricCount && <Link href={href({ metricPage: String(parsed.data.metricPage + 1) })} className="underline">More measured results</Link>}</p>}</section>}
    <details className="rounded-lg border border-border p-4"><summary className="cursor-pointer font-medium">Retained query inputs and calculation output</summary><pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words text-xs">{raw(receipt.query).slice(0, 100000)}</pre>
      {raw(receipt.query).length > 100000 && <p className="mt-2 text-sm">This preview is shortened. The complete retained evidence is available below.</p>}
      <a href={`/api/evidence/${id}`} className="mt-3 inline-block text-sm underline">Open complete retained query and records as JSON</a></details>
    <section id="supporting-records"><h2 className="text-lg font-semibold">Supporting records</h2>
      {allRecords.length > 25 && <form role="search" className="mt-2 flex flex-wrap gap-2">{metric && <input type="hidden" name="metric" value={metric.id} />}{parsed.data.from && <input type="hidden" name="from" value={parsed.data.from} />}<label className="sr-only" htmlFor="evidence-search">Search supporting records</label><input id="evidence-search" type="search" name="q" defaultValue={parsed.data.q} maxLength={100} placeholder="Search records" className="min-h-10 min-w-0 rounded-lg border border-border bg-background px-3 text-sm" /><button className="min-h-10 rounded-lg border border-border px-3 text-sm hover:bg-muted">Search</button></form>}
      <p className="mt-1 text-sm text-muted-foreground">{q ? `${supportingRecords.length} of ${allRecords.length}` : supportingRecords.length} retained records. {visible.length ? `Showing ${sourceOffset + 1} to ${sourceOffset + visible.length}.` : <>No supporting records in this selection. {(q || parsed.data.sourcePage > 0) && <Link href={href({ q: "", sourcePage: "0" })} className="underline">Show all</Link>}</>}</p>
      <div className="mt-4 space-y-4">{visible.map(source => <article id={`source-${source.id}`} key={source.id} className="rounded-lg border border-border bg-card p-4"><h3 className="break-words font-medium">{recordSummary(source.record, locale) || `Retained ${source.type} evidence`}</h3><p className="mt-1 text-xs text-muted-foreground">{source.type}</p>
        <a href={source.href} aria-label={`Open supporting record: ${recordSummary(source.record, locale) || source.id}`} className="mt-2 inline-block text-sm underline">Open supporting record</a><details className="mt-3"><summary className="cursor-pointer text-sm">Original dated record<span className="sr-only"> for {recordSummary(source.record, locale) || source.id}</span></summary><p className="mt-2 break-all font-mono text-xs text-muted-foreground">{source.id}</p><pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-xs">{raw(source.record).slice(0, 100000)}</pre>
          {raw(source.record).length > 100000 && <p className="mt-2 text-sm">This preview is shortened. Open the complete original record below.</p>}
          <a href={`/api/evidence/${id}?${new URLSearchParams({ source: source.id })}`} className="mt-2 inline-block text-sm underline">Complete original record as JSON</a></details></article>)}</div>
      {sourceOffset + 25 < supportingRecords.length && <Link href={href({ sourcePage: String(parsed.data.sourcePage + 1) })} className="mt-4 inline-block text-sm underline">More supporting records</Link>}
      {parsed.data.sourcePage > 0 && <Link href={href({ sourcePage: String(parsed.data.sourcePage - 1) })} className="ml-4 mt-4 inline-block text-sm underline">Previous supporting records</Link>}</section>
    <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Calculation identity</summary><p className="mt-2 break-all">{receipt.id} · {receipt.calculationVersion}</p></details>
  </main>;
}
