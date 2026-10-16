import { requireWorkspace } from "@/lib/auth";
import { PendingHoldEditor, type PendingPosting } from "@/app/money/transactions/pending-hold-editor";
import { loadPendingResolutions, releasedPendingMinor } from "@/lib/finance/pending-holds";

export async function PendingSettlement({ importId, sourceId, externalId, accountId, currency }: {
  importId: string; sourceId: string; externalId: string; accountId: string; currency: string;
}) {
  const { supabase, workspace } = await requireWorkspace();
  const pending = await supabase.from("transactions")
    .select("id, version, description, posted_on, amount_minor::text, transaction_sources!inner(source_transactions!inner(external_id, import_id))")
    .eq("workspace_id", workspace.id).eq("account_id", accountId).eq("currency_code", currency).eq("status", "pending")
    .eq("kind", "ordinary").lt("amount_minor", 0).eq("transaction_sources.source_transactions.external_id", externalId)
    .neq("transaction_sources.source_transactions.import_id", importId).order("id").limit(101);
  if (pending.error) return <p role="alert">Could not load pending matches. Inspect the pending evidence before accepting this row.</p>;
  if (pending.data.length > 100) return <p>More than 100 matching holds. Inspect the ledger to resolve the ambiguity before settling.</p>;
  let released: bigint[];
  try { released = await Promise.all(pending.data.map(async row => releasedPendingMinor(await loadPendingResolutions(supabase, workspace.id, row.id)))); }
  catch { return <p role="alert">Pending lifecycle evidence is unavailable. Retry before settling.</p>; }
  const choices = pending.data.flatMap((row, index) => released[index] >= -BigInt(row.amount_minor) ? [] : [
    <PendingHoldEditor key={`${row.id}:${released[index]}`} pending={row as PendingPosting} currency={currency}
      releasedMinor={released[index].toString()} importId={importId} sourceId={sourceId} />]);
  return choices.length ? <div className="space-y-3"><p className="text-sm text-muted-foreground">This row matches pending payments. Pick the one it settles, even if the date or amount differs. Accepting as new leaves them pending.</p>{choices}</div> : null;
}
