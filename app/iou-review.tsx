import { cache } from "react";
import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";
import { IouCard } from "@/components/iou-card";
import { openIouProposals } from "@/lib/ai/iou-proposals";

export const loadIouReview = cache((db: SupabaseClient, workspaceId: string) => openIouProposals(db, workspaceId));

/** Loans and repayments waiting for a yes/no on the agent team page; Home lists them under Waiting for you. */
export async function IouReview({ db, workspaceId }: { db: SupabaseClient; workspaceId: string }) {
  // A failed load says so; treating it as empty would hide loans waiting for a decision.
  const proposals = await loadIouReview(db, workspaceId).catch(() => null);
  if (!proposals) return <p role="alert" className="text-sm text-danger">Could not load the loans to review. <Link href="/ai/agents" className="underline">Try again</Link></p>;
  if (!proposals.length) return null;
  return <section aria-label="Loans to review" className="space-y-1">
    <h2 className="text-sm font-medium text-ai">Loans to review</h2>
    {proposals.map(({ id, title, detail }) => <IouCard key={id} id={id} initial={{ id, title, detail, status: "proposed" }} />)}
  </section>;
}
