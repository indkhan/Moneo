import type { SupabaseClient } from "@supabase/supabase-js";
import { RecurringCards } from "./cards";
import { openRecurringProposals, syncRecurringProposals } from "@/lib/ai/recurring-proposals";

/** Recurring changes detection caught, as the same proposal cards chat shows; accepting runs the same apply path. */
export async function RecurringReview({ supabase, workspace, prices = false }: { supabase: SupabaseClient; workspace: { id: string; timezone: string; locale: string }; prices?: boolean }) {
  // A review aid only: if detection or the read fails, the page renders without it.
  const proposals = await syncRecurringProposals({ supabase, workspace })
    .then(() => openRecurringProposals(supabase, workspace.id, prices ? ["recurring_price:"] : undefined)).catch(() => []);
  if (!proposals.length) return null;
  return <section aria-label="Recurring to review" className="space-y-1">
    <h2 className="text-sm font-medium text-ai">Recurring to review</h2>
    <RecurringCards cards={proposals} />
  </section>;
}
