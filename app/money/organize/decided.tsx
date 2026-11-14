import Link from "next/link";
import { displayFormat } from "@/lib/display-format";
import { PAGE_SIZE, SOURCES, SOURCE_LABEL, type Decision, type RunGroup } from "@/lib/organize/surfaces";
import { confirmSafely, undoSafely } from "./actions";
import { Action, Chips, Empty, card } from "./parts";

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const href = (params: Record<string, string | number | undefined>) => `/money/organize?${new URLSearchParams(Object.entries({ tab: "decided", ...params }).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]))}`;

export function Decided({ decisions, total, groups, source, page, categories, merchants, locale, timezone }: { decisions: Decision[]; total: number; groups: RunGroup[]; source?: string; page: number;
  categories: Map<string, string>; merchants: Map<string, string>; locale: string; timezone: string }) {
  const { date, money, dateTime } = displayFormat(locale, timezone);
  return <div className="space-y-4">
    <Chips label="Filter by who decided" items={[{ href: href({}), text: "All", active: !source }, ...SOURCES.map(item => ({ href: href({ source: item }), text: SOURCE_LABEL[item], active: source === item }))]} />
    {groups.length > 0 && !source && <section aria-label="Organizer passes" className="space-y-2">
      <h2 className="text-sm font-medium">Take back a whole pass</h2>
      <ul className="divide-y divide-border rounded-xl border border-border bg-card text-sm">{groups.map(group => <li key={group.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
        <span className="min-w-0 flex-1">{dateTime(group.createdAt)}<span className="text-muted-foreground"> · {plural(group.opIds.length, "label", "labels")}</span></span>
        <Action action={undoSafely} fields={group.opIds.map(id => ["op", id])} label="Undo all" name={`Undo all ${group.opIds.length} labels from ${dateTime(group.createdAt)}`} />
      </li>)}</ul>
      <p className="text-xs text-muted-foreground">Rows you changed since are left as they are.</p>
    </section>}
    {decisions.length === 0 ? <Empty>No rows were labelled {source ? `by ${SOURCE_LABEL[source as keyof typeof SOURCE_LABEL].toLowerCase()}` : "by the organizer"} yet.</Empty>
      : <ul aria-label="Decisions" className="space-y-2">{decisions.map(row => {
        const labels = [row.category_id && categories.get(row.category_id), row.merchant_id && merchants.get(row.merchant_id)].filter(Boolean).join(" · ") || "No labels";
        return <li key={row.id}><article aria-label={row.description} className={`${card} !p-3.5 sm:!p-4`}>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="shrink-0 font-mono text-xs text-muted-foreground">{date(row.posted_on)}</span>
            <Link href={`/money/transactions?transaction=${row.id}`} className="min-w-0 flex-1 truncate font-medium hover:underline">{row.description}</Link>
            <span className="shrink-0 font-mono text-sm">{money(row.amount_minor, row.currency_code)}</span>
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span>{labels}</span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{SOURCE_LABEL[row.source]}{row.ai_confidence && ` · ${row.ai_confidence} confidence`}</span>
          </p>
          {row.ai_reason && <p className="mt-1 text-sm text-muted-foreground">{row.ai_reason}</p>}
          {(row.source === "ai" || row.organize_op_id) && <div className="mt-2 flex flex-wrap gap-2">
            {row.source === "ai" && <Action action={confirmSafely} fields={[["row", row.id]]} label="Looks right" name={`Confirm the labels on ${row.description}`} tone="primary" />}
            {row.organize_op_id && <Action action={undoSafely} fields={[["op", row.organize_op_id]]} label="Undo" name={`Undo the labels on ${row.description}`} />}
          </div>}
        </article></li>;
      })}</ul>}
    {total > PAGE_SIZE && <div className="flex flex-wrap items-center gap-4 text-sm">
      {page > 0 && <Link className="underline" href={href({ source, page: page - 1 || undefined })}>Newer</Link>}
      <span className="text-muted-foreground">{page * PAGE_SIZE + 1}–{Math.min(total, (page + 1) * PAGE_SIZE)} of {total}</span>
      {(page + 1) * PAGE_SIZE < total && <Link className="underline" href={href({ source, page: page + 1 })}>Older</Link>}
    </div>}
  </div>;
}
