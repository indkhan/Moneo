import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { openStandaloneProposals } from "@/lib/ai/open-proposals";
import { syncRecurringProposals } from "@/lib/ai/recurring-proposals";
import { RefreshPage } from "./refresh-page";
import { WaitingForYouList } from "./waiting-for-you-list";

type Workspace = { id: string; timezone: string; locale: string };

// Both are memoized per request so Home can start them before its own data resolves.
export const loadWaitingForYou = cache((supabase: SupabaseClient, workspace: Workspace) => openStandaloneProposals(supabase, workspace.id).catch(() => []));
// Detection reads the whole ledger, far slower than the cards. It runs beside the page and never holds it back; if it fails, the stored cards stand.
export const detectRecurring = cache((supabase: SupabaseClient, workspace: Workspace) => syncRecurringProposals({ supabase, workspace }).catch(() => false));

/** Every open standalone card (loans, expenses, balances, recurring changes) on Home; hidden when nothing waits. */
export async function WaitingForYou({ supabase, workspace }: { supabase: SupabaseClient; workspace: Workspace }) {
  const proposals = await loadWaitingForYou(supabase, workspace);
  return proposals.length ? <WaitingForYouList proposals={proposals} /> : null;
}

/** Renders nothing; when detection raised or closed a recurring card, reloads the page once so the list matches. Put it under Suspense. */
export async function RecurringDetection({ supabase, workspace }: { supabase: SupabaseClient; workspace: Workspace }) {
  return await detectRecurring(supabase, workspace) ? <RefreshPage /> : null;
}
