"use client";
import { useActionState } from "react";
import { saveInsightPreferences, restoreInsights } from "@/app/insights/actions";
import type { InsightPreferences } from "@/lib/finance/insights";
import { formatInputAmount } from "@/lib/finance/format";

export function InsightsForm({ preferences, dismissedCount }: { preferences: InsightPreferences; dismissedCount: number }) {
  const [state, action, pending] = useActionState(saveInsightPreferences, {});
  const field = "min-h-10 rounded-lg border border-border bg-card px-3 py-2 text-sm font-normal";
  return <section className="rounded-xl border border-border bg-card p-6"><h2 className="text-sm font-medium">Insight relevance</h2>
    <p className="mt-1 text-sm text-muted-foreground">Choose which insights are worth showing. They are calculated in the app; no AI provider receives your data for them.</p>
    <form action={action} className="mt-4 grid gap-3 sm:grid-cols-2">
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="importantOnly" defaultChecked={preferences.important_only} />Important insights only</label>
      <label className="grid gap-1.5 text-sm font-medium">Minimum spending change<input name="minimumChange" defaultValue={formatInputAmount(preferences.minimum_change_minor, preferences.currency_code)} className={field} required /></label>
      <label className="grid gap-1.5 text-sm font-medium">Comparison threshold currency<input name="currency" defaultValue={preferences.currency_code} maxLength={3} pattern="[A-Z]{3}" className={field} required /></label>
      <label className="grid gap-1.5 text-sm font-medium">Upcoming payment lookahead (days)<input type="number" name="upcomingDays" min={1} max={30} defaultValue={preferences.upcoming_days} className={field} required /></label>
      <label className="grid gap-1.5 text-sm font-medium">Maximum insights<input type="number" name="maxItems" min={1} max={20} defaultValue={preferences.max_items} className={field} required /></label>
      <details className="text-sm text-muted-foreground sm:col-span-2"><summary className="cursor-pointer">More details</summary><p className="mt-2">Spending alerts need at least a 20% increase and the minimum amount above, in the selected currency. Large-expense alerts need ten earlier expenses in the same account and an amount three times their typical size. Other currencies are not converted.</p></details>
      <button disabled={pending} className="min-h-10 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground sm:justify-self-start">Save insight preferences</button>
      {state.error ? <p role="alert" className="text-sm text-danger">{state.error}</p> : state.saved ? <p role="status" className="text-sm text-muted-foreground">Insight preferences saved.</p> : null}
    </form>
    <form action={restoreInsights} className="mt-4 border-t border-border pt-4"><p className="mb-2 text-sm text-muted-foreground">Dismissed an insight by mistake? Bring it back.</p><button disabled={!dismissedCount} className="text-sm text-brand underline disabled:opacity-50">Restore {dismissedCount} dismissed insights</button></form>
  </section>;
}
