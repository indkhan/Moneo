import type { SupabaseClient } from "@supabase/supabase-js";
import { IouCard } from "@/components/iou-card";
import { openIouProposals } from "@/lib/ai/iou-proposals";

/** Loans and repayments waiting for a yes/no, on Home and the agent team page. */
export async function IouReview({ db, workspaceId }: { db: SupabaseClient; workspaceId: string }) {
  const proposals = await openIouProposals(db, workspaceId).catch(() => []);
  if (!proposals.length) return null;
  return <section aria-label="Loans to review" className="space-y-1">
    <h2 className="text-sm font-medium text-ai">Loans to review</h2>
    {proposals.map(({ id, title, detail }) => <IouCard key={id} id={id} initial={{ id, title, detail, status: "proposed" }} />)}
  </section>;
}
