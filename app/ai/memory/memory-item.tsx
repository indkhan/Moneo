import Link from "next/link";
import { SafeForm } from "@/components/safe-form";
import type { SafeState } from "@/lib/safe-action";
import type { MemoryRow } from "@/lib/ai/memory";
import { MEMORY_KIND_LABELS } from "@/lib/ai/memory-note";
import { confirmMemorySafely, editMemorySafely, endMemorySafely, forgetMemorySafely, undoMemorySafely } from "./actions";

export type Dates = { from: string | null; until: string | null; said: string; changed: string | null };

const card = "rounded-xl border border-border bg-card p-4 text-sm";
const field = "min-h-9 w-full min-w-0 rounded-lg border border-border bg-background px-2 text-sm text-foreground";
const quiet = "min-h-9 rounded-lg border border-border px-3 text-sm hover:bg-muted disabled:opacity-50";
const primary = "min-h-9 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50";

function Button({ action, memory, label, name, tone = "quiet" }: { action: (state: SafeState, form: FormData) => Promise<SafeState>; memory: string; label: string; name: string; tone?: "quiet" | "primary" }) {
  return <SafeForm action={action} className="inline-flex flex-wrap items-center gap-2">
    <input type="hidden" name="memory" value={memory} />
    <button aria-label={name} className={tone === "primary" ? primary : quiet}>{label}</button>
  </SafeForm>;
}

function When({ dates }: { dates: Dates }) {
  const span = [dates.from && `from ${dates.from}`, dates.until && `until ${dates.until}`].filter(Boolean).join(" ");
  return <>{span ? `True ${span} · ` : ""}Said {dates.said}</>;
}

function Source({ row }: { row: MemoryRow }) {
  if (row.saved_by === "owner") return <span>You wrote this here</span>;
  return <details className="inline">
    <summary className="cursor-pointer underline">Show source</summary>
    <blockquote className="mt-1 border-l-2 border-border pl-2 italic">“{row.quote}”</blockquote>
    {row.conversation_id && <Link href={`/ai?conversation=${row.conversation_id}`} className="underline">Open the chat</Link>}
  </details>;
}

export function MemoryItem({ row, dates, kinds }: { row: MemoryRow; dates: Dates; kinds: [string, string][] }) {
  return <li><section aria-label={`Memory: ${row.statement}`} className={card}>
    <p>{row.statement}</p>
    <div className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted-foreground"><span><When dates={dates} /></span><Source row={row} /></div>
    <div className="mt-3 flex flex-wrap items-start gap-2">
      <details className="min-w-0 open:basis-full">
        <summary className={`${quiet} inline-flex cursor-pointer items-center`}>Edit</summary>
        <SafeForm action={editMemorySafely} className="mt-2 grid gap-2 sm:grid-cols-2">
          <input type="hidden" name="memory" value={row.id} />
          <label className="sm:col-span-2 text-xs text-muted-foreground">What Moneo should remember
            <textarea name="statement" defaultValue={row.statement} maxLength={300} rows={2} className={`${field} mt-1 py-1.5`} /></label>
          <label className="text-xs text-muted-foreground">Kind
            <select name="kind" defaultValue={row.kind} className={`${field} mt-1`}>{kinds.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <span className="hidden sm:block" />
          <label className="text-xs text-muted-foreground">True from<input type="date" name="from" defaultValue={row.valid_from ?? ""} className={`${field} mt-1`} /></label>
          <label className="text-xs text-muted-foreground">True until<input type="date" name="until" defaultValue={row.valid_until ?? ""} className={`${field} mt-1`} /></label>
          <div><button className={primary}>Save</button></div>
          <p className="sm:col-span-2 text-xs text-muted-foreground">The earlier version is kept in History.</p>
        </SafeForm>
      </details>
      <Button action={endMemorySafely} memory={row.id} label="No longer true" name={`${row.statement} is no longer true`} />
      <Forget row={row} />
    </div>
  </section></li>;
}

function Forget({ row }: { row: MemoryRow }) {
  return <details>
    <summary className={`${quiet} inline-flex cursor-pointer items-center`}>Forget</summary>
    <div className="mt-2 space-y-2 text-xs text-muted-foreground">
      <p>Deletes this memory with all its versions, earlier and later, and the quote of your words it kept. It also disappears from the memory notes under answers. The chats themselves stay, including anything you or Moneo wrote there; delete a chat to remove that. This can&apos;t be undone.</p>
      <Button action={forgetMemorySafely} memory={row.id} label="Forget permanently" name={`Forget ${row.statement} permanently`} tone="primary" />
    </div>
  </details>;
}

export function Suggested({ row, dates }: { row: MemoryRow; dates: Dates }) {
  return <li><section aria-label={`Suggested memory: ${row.statement}`} className={card}>
    <p><span className="mr-2 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{MEMORY_KIND_LABELS[row.kind]}</span>{row.statement}</p>
    <div className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted-foreground"><span><When dates={dates} /></span><Source row={row} /></div>
    <div className="mt-3 flex flex-wrap gap-2">
      <Button action={confirmMemorySafely} memory={row.id} label="Save" name={`Save ${row.statement}`} tone="primary" />
      <Button action={undoMemorySafely} memory={row.id} label="Not now" name={`Don't save ${row.statement}`} />
    </div>
  </section></li>;
}

export function Change({ before, beforeDates, after, afterDates }: { before: MemoryRow; beforeDates: Dates; after: MemoryRow | null; afterDates: Dates | null }) {
  const label = before.status === "ended" ? "No longer true" : before.status !== "replaced" ? "Time ran out" : after?.saved_by === "owner" ? "You corrected it" : "Changed";
  return <li><section aria-label={`${label}: ${before.statement}`} className={card}>
    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}{beforeDates.changed && ` · ${beforeDates.changed}`} · {MEMORY_KIND_LABELS[before.kind]}</p>
    <p className="mt-2"><span className="text-muted-foreground">Before: </span>{before.statement}</p>
    <div className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted-foreground"><span><When dates={beforeDates} /></span><Source row={before} /></div>
    {after && afterDates && <>
      <p className="mt-3"><span className="text-muted-foreground">{after.status === "active" ? "Now: " : "Then: "}</span>{after.statement}</p>
      <div className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted-foreground"><span><When dates={afterDates} /></span><Source row={after} /></div>
    </>}
    <div className="mt-3 flex flex-wrap gap-2">
      {before.status === "ended" && <Button action={undoMemorySafely} memory={before.id} label="It's still true" name={`${before.statement} is still true`} />}
      <Forget row={before} />
    </div>
  </section></li>;
}
