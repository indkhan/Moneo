import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { IouCard } from "@/components/iou-card";
import { openIouProposals } from "@/lib/ai/iou-proposals";

// Memoized per request so Home can start this read before its own data resolves.
export const loadIouReview = cache((db: SupabaseClient, workspaceId: string) => openIouProposals(db, workspaceId).catch(() => []));

/** Loans and repayments waiting for a yes/no, on Home and the agent team page. */
export async function IouReview({ db, workspaceId }: { db: SupabaseClient; workspaceId: string }) {
  const proposals = await loadIouReview(db, workspaceId);
  if (!proposals.length) return null;
  return <section aria-label="Loans to review" className="space-y-1">
    <h2 className="text-sm font-medium text-ai">Loans to review</h2>
    {proposals.map(({ id, title, detail }) => <IouCard key={id} id={id} initial={{ id, title, detail, status: "proposed" }} />)}
  </section>;
}
