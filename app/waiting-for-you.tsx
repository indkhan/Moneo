import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { openStandaloneProposals } from "@/lib/ai/open-proposals";
import { syncRecurringProposals } from "@/lib/ai/recurring-proposals";
import { WaitingForYouList } from "./waiting-for-you-list";

type Workspace = { id: string; timezone: string; locale: string };

// Memoized per request so Home can start this read before its own data resolves. Detection raises or closes its
// recurring cards first, so they are listed with the rest; if it fails, the cards already stored still show.
export const loadWaitingForYou = cache((supabase: SupabaseClient, workspace: Workspace) => syncRecurringProposals({ supabase, workspace }).catch(() => undefined)
  .then(() => openStandaloneProposals(supabase, workspace.id)).catch(() => []));

/** Every open standalone card (loans, expenses, balances, recurring changes) on Home; hidden when nothing waits. */
export async function WaitingForYou({ supabase, workspace }: { supabase: SupabaseClient; workspace: Workspace }) {
  const proposals = await loadWaitingForYou(supabase, workspace);
  return proposals.length ? <WaitingForYouList proposals={proposals} /> : null;
}
