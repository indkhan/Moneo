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
  const choices = [];
  for (const row of pending.data) {
    let released: bigint;
    try { released = releasedPendingMinor(await loadPendingResolutions(supabase, workspace.id, row.id)); }
    catch { return <p role="alert">Pending lifecycle evidence is unavailable. Retry before settling.</p>; }
    if (released >= -BigInt(row.amount_minor)) continue;
    choices.push(<PendingHoldEditor key={`${row.id}:${released}`} pending={row as PendingPosting} currency={currency}
      releasedMinor={released.toString()} importId={importId} sourceId={sourceId} />);
  }
  return choices.length ? <div className="mt-4"><p className="text-sm">The same source reference has outstanding pending evidence. Select the correct hold explicitly; dates and amounts may differ. Accept as new keeps these holds active.</p>{choices}</div> : null;
}
