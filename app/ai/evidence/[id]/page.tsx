import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { readEvidenceView } from "@/lib/finance/evidence-view";
import { formatMoney } from "@/lib/finance/format";
import { financialMetricHref, financialQualificationText } from "@/lib/finance/verified-claims";
export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ metric?: string; sourcePage?: string; metricPage?: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { redirect("/login"); }
  const { id } = await params, query = await searchParams;
  const parsed = z.object({ id: z.uuid(), metric: z.string().min(1).max(200).optional(), sourcePage: z.coerce.number().int().min(0).max(1000).default(0), metricPage: z.coerce.number().int().min(0).max(40).default(0) }).safeParse({ id, ...query });
  if (!parsed.success) notFound();
  const view = await readEvidenceView(context, id, parsed.data.metric).catch(() => null);
  if (!view) notFound();
  const { receipt, metric, freshness, supportingRecords } = view;
  const sourceOffset = parsed.data.sourcePage * 100, metricOffset = parsed.data.metricPage * 50;
  const visible = supportingRecords.slice(sourceOffset, sourceOffset + 100);
  const raw = (value: unknown) => JSON.stringify(value, null, 2);
  const amount = (item: typeof receipt.metrics[number]) => item.valueMinor === null ? "Unavailable" : item.unit === "count" ? `${item.valueMinor} records (${item.currency} scope)` : formatMoney(item.valueMinor, item.currency);
  const href = (extra: Record<string, string>) => `/ai/evidence/${id}?${new URLSearchParams({ ...(metric ? { metric: metric.id } : {}), ...extra })}`;
  return <main className="mx-auto max-w-5xl space-y-6 px-5 py-8 lg:px-8">
    <Link href="/ai" className="text-sm underline">AI and saved reviews</Link>
    <header><p className="text-xs font-semibold uppercase tracking-widest text-brand">Retained financial evidence</p><h1 className="mt-2 text-2xl font-semibold">Calculation and supporting records</h1>
      <p className="mt-2 text-sm text-muted-foreground">Captured <time dateTime={receipt.fetchedAt}>{receipt.fetchedAt}</time>. This original dated result remains available when source records change.</p></header>
    <div role="status" className="rounded-lg border border-border bg-card p-4"><strong className="capitalize">Evidence {freshness.status}</strong><p className="mt-1 text-sm">{freshness.reason}</p></div>
    {metric ? <section className="rounded-lg border border-border bg-card p-5"><h2 className="text-lg font-semibold">{metric.label}</h2><p className="mt-3 text-xl font-semibold">{amount(metric)}</p>
      <p className="mt-2 text-sm">Period {metric.period.from} to {metric.period.to}</p>
      {!!metric.qualifiers.length && <p className="mt-2 text-sm">{metric.qualifiers.map(financialQualificationText).join(" ")}</p>}
      <h3 className="mt-4 font-medium">Actual calculation</h3><p className="mt-2 whitespace-pre-wrap break-words text-sm">{metric.calculation}</p>
      <Link href={`/ai/evidence/${id}`} className="mt-3 inline-block text-sm underline">All measures in this query</Link></section>
      : <section><h2 className="text-lg font-semibold">Measured results</h2><ul className="mt-3 space-y-2">{receipt.metrics.slice(metricOffset, metricOffset + 50).map(item => <li key={item.id}><Link href={financialMetricHref(id, item.id)} className="text-sm underline">{item.label}: {amount(item)} · {item.period.from} to {item.period.to}</Link></li>)}</ul>
        {metricOffset + 50 < receipt.metrics.length && <Link href={href({ metricPage: String(parsed.data.metricPage + 1) })} className="mt-3 inline-block text-sm underline">More measured results</Link>}</section>}
    <details className="rounded-lg border border-border p-4"><summary className="cursor-pointer font-medium">Retained query inputs and calculation output</summary><pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words text-xs">{raw(receipt.query).slice(0, 100000)}</pre>
      {raw(receipt.query).length > 100000 && <p className="mt-2 text-sm">This preview is shortened. The complete retained evidence is available below.</p>}
      <a href={`/api/evidence/${id}`} className="mt-3 inline-block text-sm underline">Open complete retained query and records as JSON</a></details>
    <section><h2 className="text-lg font-semibold">Supporting records</h2><p className="mt-1 text-sm text-muted-foreground">{supportingRecords.length} retained records. {visible.length ? `Showing ${sourceOffset + 1} to ${sourceOffset + visible.length}.` : "No supporting records in this selection."}</p>
      <div className="mt-4 space-y-4">{visible.map(source => <article id={`source-${source.id}`} key={source.id} className="rounded-lg border border-border bg-card p-4"><h3 className="font-medium">Retained {source.type} evidence</h3><p className="mt-1 break-all font-mono text-xs text-muted-foreground">{source.id}</p>
        <a href={source.href} className="mt-2 inline-block text-sm underline">Open supporting record</a><details className="mt-3"><summary className="cursor-pointer text-sm">Original dated record</summary><pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words text-xs">{raw(source.record).slice(0, 100000)}</pre>
          {raw(source.record).length > 100000 && <p className="mt-2 text-sm">This preview is shortened. Open the complete original record below.</p>}
          <a href={`/api/evidence/${id}?${new URLSearchParams({ source: source.id })}`} className="mt-2 inline-block text-sm underline">Complete original record as JSON</a></details></article>)}</div>
      {sourceOffset + 100 < supportingRecords.length && <Link href={href({ sourcePage: String(parsed.data.sourcePage + 1) })} className="mt-4 inline-block text-sm underline">More supporting records</Link>}
      {parsed.data.sourcePage > 0 && <Link href={href({ sourcePage: String(parsed.data.sourcePage - 1) })} className="ml-4 mt-4 inline-block text-sm underline">Previous supporting records</Link>}</section>
    <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Calculation identity</summary><p className="mt-2 break-all">{receipt.id} · {receipt.calculationVersion}</p></details>
  </main>;
}
