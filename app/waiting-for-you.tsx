import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { openStandaloneProposals, type OpenProposal } from "@/lib/ai/open-proposals";
import { syncRecurringProposals } from "@/lib/ai/recurring-proposals";
import { loadHomeReview, type HomeReview } from "@/lib/ai/home-review";
import { RefreshPage } from "./refresh-page";
import { WaitingForYouList } from "./waiting-for-you-list";

const waitingCardsCouldNotBeLoaded = () => null;

type Workspace = { id: string; timezone: string; locale: string };

export const loadWaitingForYou = cache((supabase: SupabaseClient, workspace: Workspace) => openStandaloneProposals(supabase, workspace.id).catch(waitingCardsCouldNotBeLoaded));
export const loadReview = cache((supabase: SupabaseClient, workspace: Workspace): Promise<HomeReview | null> => loadHomeReview(supabase, workspace.id).catch(waitingCardsCouldNotBeLoaded));
export const detectRecurring = cache((supabase: SupabaseClient, workspace: Workspace) => syncRecurringProposals({ supabase, workspace }).catch(() => false));

export const WaitingForYou = ({ proposals, review, locale }: { proposals: OpenProposal[] | null; review?: HomeReview | null; locale?: string }) =>
  !proposals || review === null ? <p role="alert" className="text-sm text-danger">Could not check what is waiting for you, so there may be cards to review. Reload the page to try again.</p>
  : proposals.length || review?.uncategorized || review?.findings.length ? <WaitingForYouList proposals={proposals} review={review} locale={locale} /> : null;

export async function RecurringDetection({ supabase, workspace }: { supabase: SupabaseClient; workspace: Workspace }) {
  return await detectRecurring(supabase, workspace) ? <RefreshPage /> : null;
}
