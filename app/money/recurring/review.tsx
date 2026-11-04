import type { SupabaseClient } from "@supabase/supabase-js";
import { RecurringCards } from "./cards";
import { openRecurringProposals, syncRecurringProposals } from "@/lib/ai/recurring-proposals";

/** Recurring changes detection caught, as the same proposal cards chat shows; accepting runs the same apply path. */
export async function RecurringReview({ supabase, workspace, prices = false }: { supabase: SupabaseClient; workspace: { id: string; timezone: string; locale: string }; prices?: boolean }) {
  // A review aid only: if detection or the read fails, the rest of the page still renders and says so here.
  const proposals: Awaited<ReturnType<typeof openRecurringProposals>> | null = await syncRecurringProposals({ supabase, workspace })
    .then(() => openRecurringProposals(supabase, workspace.id, prices ? ["recurring_price:"] : undefined)).catch(() => null);
  if (!proposals) return <p role="status" className="rounded-xl border border-border bg-card p-4 text-sm">Could not check for recurring changes, so there may be some to review. Your schedules below are fine. <a className="underline" href="/money/recurring">Try again</a></p>;
  if (!proposals.length) return null;
  return <section aria-label="Recurring to review" className="space-y-1">
    <h2 className="text-sm font-medium text-ai">Recurring to review</h2>
    <RecurringCards cards={proposals} />
  </section>;
}
