"use client";
import { useActionState } from "react";
import { saveInsightPreferences, restoreInsights } from "@/app/insights/actions";
import type { InsightPreferences } from "@/lib/finance/insights";
import { formatInputAmount } from "@/lib/finance/format";

export function InsightsForm({ preferences, dismissedCount }: { preferences: InsightPreferences; dismissedCount: number }) {
  const [state, action, pending] = useActionState(saveInsightPreferences, {});
  const field = "mt-1 rounded-lg border border-border bg-background px-3 py-2 text-sm";
  return <section className="rounded-xl border border-border bg-card p-5"><h2 className="font-semibold">Insight relevance and dismissal</h2>
    <p className="mt-2 text-sm text-muted-foreground">Insights are calculated from dated financial evidence. Type muting is above. Dismissals apply to the same evidence; corrections can produce a new insight. No provider receives data to calculate these cards.</p>
    <form action={action} className="mt-4 grid gap-4 sm:grid-cols-2">
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="importantOnly" defaultChecked={preferences.important_only} />Important insights only</label>
      <label className="grid text-sm">Minimum spending change<input name="minimumChange" defaultValue={formatInputAmount(preferences.minimum_change_minor, preferences.currency_code)} className={field} required /></label>
      <label className="grid text-sm">Comparison threshold currency<input name="currency" defaultValue={preferences.currency_code} maxLength={3} pattern="[A-Z]{3}" className={field} required /></label>
      <label className="grid text-sm">Upcoming payment lookahead (days)<input type="number" name="upcomingDays" min={1} max={30} defaultValue={preferences.upcoming_days} className={field} required /></label>
      <label className="grid text-sm">Maximum insights<input type="number" name="maxItems" min={1} max={20} defaultValue={preferences.max_items} className={field} required /></label>
      <p className="text-xs text-muted-foreground">Spending comparisons require at least a 20% increase and this minimum amount in the selected currency. Large-activity comparisons require ten earlier same-account expenses and three times their median. Other currencies are not converted for alerts.</p>
      <button disabled={pending} className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground">Save insight preferences</button>
      {state.error ? <p role="alert" className="text-sm text-red-700">{state.error}</p> : state.saved ? <p role="status" className="text-sm">Insight preferences saved.</p> : null}
    </form>
    <form action={restoreInsights} className="mt-4"><button disabled={!dismissedCount} className="text-sm text-brand underline">Restore {dismissedCount} dismissed insights</button></form>
  </section>;
}
