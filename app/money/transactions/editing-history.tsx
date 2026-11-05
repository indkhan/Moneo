import { requireWorkspace } from "@/lib/auth";
import { SafeForm } from "@/components/safe-form";
import { restoreManualTransactionSafely, undoTransactionBatchSafely } from "./actions";
import { describePatch } from "./labels";

export async function EditingHistory({ query, names }: { query: string; names: Parameters<typeof describePatch>[1] }) {
  const { supabase, workspace } = await requireWorkspace();
  const { data: batches, error: batchError } = await supabase.from("transaction_batches").select("id, selection, patch, created_at, undone").eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(10);
  if (batchError) throw batchError;
  const ids = [...new Set((batches ?? []).flatMap(batch => (batch.selection as { id: string }[]).map(row => row.id)))];
  const { data: rows, error } = ids.length ? await supabase.from("transactions").select("id, version").eq("workspace_id", workspace.id).in("id", ids) : { data: [], error: null };
  if (error) throw error;
  const versions = new Map((rows ?? []).map(row => [row.id, row.version]));
  return <details className="rounded-xl border border-border bg-card p-4">
    <summary className="cursor-pointer text-sm font-semibold">Batch history</summary>
    <p className="mt-2 text-sm text-muted-foreground">Your latest 10 bulk edits. A manual transaction is undone from its own details.</p>
    <ul className="mt-3 space-y-3">{(batches ?? []).map(batch => {
      const selection = batch.selection as { id: string }[];
      const targets = selection.filter(row => versions.has(row.id)).map(row => ({ id: row.id, version: versions.get(row.id)! }));
      return <li key={batch.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm">
        <div><p>Bulk edit · {selection.length} transactions · {new Date(batch.created_at).toLocaleString(workspace.locale, { timeZone: workspace.timezone })}{batch.undone ? " · Undone" : ""}</p><p className="text-muted-foreground">{describePatch(batch.patch, names)}</p></div>
        {!batch.undone && targets.length === selection.length && <SafeForm action={undoTransactionBatchSafely}><input type="hidden" name="batchId" value={batch.id} /><input type="hidden" name="rows" value={JSON.stringify(targets)} /><input type="hidden" name="query" value={query} /><button className="underline">Undo batch</button></SafeForm>}
      </li>;
    })}</ul>
    {!batches?.length && <p className="mt-3 text-sm text-muted-foreground">No bulk changes yet.</p>}
  </details>;
}

/** Shown after a manual entry is undone, so it can be brought back with its original ID. */
export async function RestoreManualEntry({ entryId }: { entryId: string }) {
  const { supabase, workspace } = await requireWorkspace();
  const { data: entry } = await supabase.from("manual_transaction_entries").select("id, version, undone_at, original_record").eq("workspace_id", workspace.id).eq("id", entryId).maybeSingle();
  if (!entry?.undone_at) return null;
  const original = entry.original_record as { description: string };
  return <SafeForm action={restoreManualTransactionSafely} className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-sm">
    <input type="hidden" name="entryId" value={entry.id} /><input type="hidden" name="entryVersion" value={entry.version} />
    <p role="status">Removed the manual transaction “{original.description}”. Its evidence is kept.</p>
    <button className="ml-auto min-h-10 rounded-lg border border-input px-3 hover:bg-muted">Restore manual entry</button>
  </SafeForm>;
}
