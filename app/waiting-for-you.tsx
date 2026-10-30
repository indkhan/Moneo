import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { openStandaloneProposals, type OpenProposal } from "@/lib/ai/open-proposals";
import { syncRecurringProposals } from "@/lib/ai/recurring-proposals";
import { loadHomeReview, type HomeReview } from "@/lib/ai/home-review";
import { RefreshPage } from "./refresh-page";
import { WaitingForYouList } from "./waiting-for-you-list";

type Workspace = { id: string; timezone: string; locale: string };

// Both are memoized per request so Home can start them before its own data resolves.
export const loadWaitingForYou = cache((supabase: SupabaseClient, workspace: Workspace) => openStandaloneProposals(supabase, workspace.id).catch(() => []));
/** What the after-sync checks left: uncategorized spending and flagged items, shown as summary cards. */
export const loadReview = cache((supabase: SupabaseClient, workspace: Workspace): Promise<HomeReview> => loadHomeReview(supabase, workspace.id).catch(() => ({ uncategorized: 0, findings: [] })));
// Detection reads the whole ledger, far slower than the cards. It runs beside the page and never holds it back; if it fails, the stored cards stand.
export const detectRecurring = cache((supabase: SupabaseClient, workspace: Workspace) => syncRecurringProposals({ supabase, workspace }).catch(() => false));

/** Every open standalone card and review summary on Home; hidden when nothing waits. */
export const WaitingForYou = ({ proposals, review }: { proposals: OpenProposal[]; review?: HomeReview }) =>
  proposals.length || review?.uncategorized || review?.findings.length ? <WaitingForYouList proposals={proposals} review={review} /> : null;

/** Renders nothing; when detection raised or closed a recurring card, reloads the page once so the list matches. Put it under Suspense. */
export async function RecurringDetection({ supabase, workspace }: { supabase: SupabaseClient; workspace: Workspace }) {
  return await detectRecurring(supabase, workspace) ? <RefreshPage /> : null;
}
