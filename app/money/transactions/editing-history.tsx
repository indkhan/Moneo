import { requireWorkspace } from "@/lib/auth";
import { formatMoney } from "@/lib/finance/format";
import { restoreManualTransaction, undoManualTransaction, undoTransactionBatch } from "./actions";

export async function EditingHistory({ query }: { query: string }) {
  const { supabase, workspace } = await requireWorkspace();
  const [{ data: entries, error: entryError }, { data: batches, error: batchError }] = await Promise.all([
    supabase.from("manual_transaction_entries").select("id, transaction_id, original_record, version, created_at, undone_at").eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(10),
    supabase.from("transaction_batches").select("id, selection, patch, created_at, undone").eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(10),
  ]);
  if (entryError || batchError) throw entryError ?? batchError;
  const ids = [...new Set([...(entries ?? []).flatMap(entry => entry.transaction_id ? [entry.transaction_id] : []),
    ...(batches ?? []).flatMap(batch => (batch.selection as { id: string }[]).map(row => row.id))])];
  const { data: rows, error } = ids.length ? await supabase.from("transactions").select("id, version").eq("workspace_id", workspace.id).in("id", ids) : { data: [], error: null };
  if (error) throw error;
  const versions = new Map((rows ?? []).map(row => [row.id, row.version]));
  return <details className="rounded-xl border border-border bg-card p-4">
    <summary className="cursor-pointer text-sm font-semibold">Manual entries and batch history</summary>
    <p className="mt-2 text-sm text-muted-foreground">Latest 10 of each. Manual creation can be undone while its ledger record has no later edits, sources or links. Original evidence is retained; restore uses the original ID.</p>
    <ul className="mt-3 space-y-3">{(entries ?? []).map(entry => {
      const original = entry.original_record as { description: string; amount_minor: string; currency_code: string; posted_on: string };
      return <li key={entry.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm">
        <p>{original.posted_on} · {original.description} · {formatMoney(original.amount_minor, original.currency_code)}{entry.undone_at ? " · Undone" : ""}</p>
        {entry.undone_at ? <form action={restoreManualTransaction}><input type="hidden" name="entryId" value={entry.id} /><input type="hidden" name="entryVersion" value={entry.version} /><button className="underline">Restore manual entry</button></form>
          : versions.get(entry.transaction_id) === 0 ? <form action={undoManualTransaction}><input type="hidden" name="entryId" value={entry.id} /><input type="hidden" name="entryVersion" value={entry.version} /><input type="hidden" name="version" value={0} /><button className="underline">Undo manual entry</button></form> : <span className="text-muted-foreground">Later changes preserved</span>}
      </li>;
    })}</ul>
    <ul className="mt-3 space-y-3">{(batches ?? []).map(batch => {
      const selection = batch.selection as { id: string }[];
      const targets = selection.filter(row => versions.has(row.id)).map(row => ({ id: row.id, version: versions.get(row.id)! }));
      return <li key={batch.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm">
        <div><p>Batch · {selection.length} transactions · {new Date(batch.created_at).toLocaleString(workspace.locale, { timeZone: workspace.timezone })}{batch.undone ? " · Undone" : ""}</p><p className="text-muted-foreground">{JSON.stringify(batch.patch)}</p></div>
        {!batch.undone && targets.length === selection.length && <form action={undoTransactionBatch}><input type="hidden" name="batchId" value={batch.id} /><input type="hidden" name="rows" value={JSON.stringify(targets)} /><input type="hidden" name="query" value={query} /><button className="underline">Undo batch</button></form>}
      </li>;
    })}</ul>
    {!entries?.length && !batches?.length && <p className="mt-3 text-sm text-muted-foreground">No manual entries or bulk changes yet.</p>}
  </details>;
}
