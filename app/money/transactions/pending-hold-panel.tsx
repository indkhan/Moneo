import { requireWorkspace } from "@/lib/auth";
import { PendingHoldEditor, type PendingPosting } from "./pending-hold-editor";
import { loadPendingResolutions, releasedPendingMinor } from "@/lib/finance/pending-holds";

export async function PendingHoldPanel({ transaction }: { transaction: PendingPosting & { account_id: string; currency_code: string } }) {
  const { supabase, workspace } = await requireWorkspace();
  const [history, postings] = await Promise.all([
    loadPendingResolutions(supabase, workspace.id, transaction.id).then(data => ({ data, error: null })).catch(() => ({ data: [], error: true })),
    supabase.from("transactions").select("id, version, description, posted_on, amount_minor::text")
      .eq("workspace_id", workspace.id).eq("account_id", transaction.account_id).eq("currency_code", transaction.currency_code)
      .eq("status", "posted").eq("kind", "ordinary").eq("review_reasons", "{}").is("transfer_id", null).is("refund_of_id", null)
      .lt("amount_minor", 0).gte("posted_on", transaction.posted_on).order("posted_on", { ascending: false }).order("id").limit(100),
  ]);
  if (history.error || postings.error) return <p role="alert">Could not load pending settlement evidence. Retry before resolving this hold.</p>;
  const resolutions = history.data;
  return <>
    <PendingHoldEditor key={`${transaction.id}:${releasedPendingMinor(resolutions)}`} pending={transaction} currency={transaction.currency_code}
      releasedMinor={releasedPendingMinor(resolutions).toString()} resolutions={resolutions} postings={postings.data as PendingPosting[]} />
    {postings.data.length === 100 && <p className="text-sm">Showing the latest 100 eligible posted debits. Older settlement evidence must be inspected before resolving this hold.</p>}
  </>;
}
