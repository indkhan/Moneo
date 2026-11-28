"use client";
import { startTransition, useRef, useState } from "react";
import { saveInsightPreferences, restoreInsights } from "@/app/insights/actions";
import type { InsightPreferences } from "@/lib/finance/insights";
import { formatInputAmount } from "@/lib/finance/format";
import { CurrencySelect } from "@/components/currency-select";
import { serialSave } from "@/lib/serial-save";
import { useDelay } from "@/lib/use-timeout";
import { SaveStatus } from "./autosave";

type Status = Parameters<typeof SaveStatus>[0]["status"];

export function InsightsForm({ preferences, dismissedCount, locale }: { preferences: InsightPreferences; dismissedCount: number; locale?: string }) {
  const form = useRef<HTMLFormElement>(null);
  const [status, setStatus] = useState<Status>(null);
  const [after] = useDelay();
  const saver = useRef<(() => Promise<void>) | null>(null);
  const request = () => (saver.current ??= serialSave(() => form.current ? new FormData(form.current) : null, async data => {
    if (!data) return;
    const result = await saveInsightPreferences({}, data).catch(() => ({ error: "Could not save insight preferences", saved: false }));
    startTransition(() => setStatus(result.error ? { section: "relevance", state: "failed", error: result.error } : { section: "relevance", state: "saved" }));
  }))();
  const changed = (delayMs: number) => { setStatus({ section: "relevance", state: "saving" }); after(() => void request(), delayMs); };
  const field = "min-h-10 rounded-lg border border-border bg-card px-3 py-2 text-sm font-normal";
  return <div className="border-t border-border pt-4">
    <h3 className="flex flex-wrap items-center gap-x-3 text-sm font-semibold">Which insights are worth showing<SaveStatus status={status} /></h3>
    <form ref={form} onSubmit={event => event.preventDefault()} onChange={event => changed(event.target instanceof HTMLInputElement && event.target.type !== "checkbox" ? 700 : 0)} className="mt-3 grid gap-3 sm:grid-cols-2">
      <label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" name="importantOnly" defaultChecked={preferences.important_only} />Important insights only</label>
      <label className="grid gap-1.5 text-sm font-medium">Minimum spending increase<input name="minimumChange" defaultValue={formatInputAmount(preferences.minimum_change_minor, preferences.currency_code)} className={field} required /></label>
      <label className="grid gap-1.5 text-sm font-medium">Currency of that amount<CurrencySelect name="currency" label="Currency of that amount" defaultValue={preferences.currency_code} locale={locale} onChange={() => changed(0)} /></label>
      <label className="grid gap-1.5 text-sm font-medium">Upcoming payment lookahead (days)<input type="number" name="upcomingDays" min={1} max={30} defaultValue={preferences.upcoming_days} className={field} required /></label>
      <label className="grid gap-1.5 text-sm font-medium">Maximum insights<input type="number" name="maxItems" min={1} max={20} defaultValue={preferences.max_items} className={field} required /></label>
      <details className="text-sm text-muted-foreground sm:col-span-2"><summary className="cursor-pointer">More details</summary><p className="mt-2">Spending alerts need at least a 20% increase and the minimum amount above, in the selected currency. Large-expense alerts need ten earlier expenses in the same account and an amount three times their typical size. Other currencies are not converted.</p></details>
    </form>
    {status?.state === "failed" && <p role="alert" className="mt-3 text-sm text-danger">{status.error}</p>}
    <form action={restoreInsights} className="mt-4"><button disabled={!dismissedCount} className="text-sm text-brand underline disabled:opacity-50">Restore {dismissedCount} dismissed insights</button></form>
  </div>;
}
