import { Settings2 } from "lucide-react";
import { requireWorkspace } from "@/lib/auth";
import type { ForecastPreferences } from "@/lib/finance/preferences";
import { formatInputAmount, formatMoney } from "@/lib/finance/format";
import { saveForecastPreferences, undoForecastPreferences } from "./preference-actions";
import { bpsToPercent, button, stackedField as field } from "./ui";

export function preferenceSummary(preferences: ForecastPreferences, locale?: string) {
  const money = (amount: string) => formatMoney(amount, preferences.currency_code, locale);
  return `Buffer ${money(preferences.safety_buffer_minor)} · ±${bpsToPercent(preferences.uncertainty_bps)}% · ${preferences.daily_spending_minor === "0" ? "no extra daily spending" : `extra spending ${money(preferences.daily_spending_minor)} daily`}`;
}

// A compact drawer: closed it is one summary line; open it holds the editor and its undo history.
export async function ForecastPreferenceEditor({ preferences, version, accounts, today }: { preferences: ForecastPreferences; version: number; accounts: { id: string; name: string; type: string }[]; today: string }) {
  const { supabase, workspace } = await requireWorkspace();
  const { data: events, error } = await supabase.from("forecast_preference_events").select("id, after, undo_of, undone_at, created_at").eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(50);
  if (error) throw error;
  return <details id="forecast-preferences" className="group rounded-xl border border-border bg-card">
    <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3 text-sm">
      <Settings2 className="size-4 text-muted-foreground" aria-hidden /><span className="font-medium">Forecast settings</span>
      <span className="text-muted-foreground">{preferenceSummary(preferences, workspace.locale)}</span>
      <span className="ml-auto text-brand group-open:hidden">Edit</span>
    </summary>
    <section aria-labelledby="forecast-preferences-heading" className="space-y-4 border-t border-border px-5 py-4">
      <div><h2 id="forecast-preferences-heading" className="text-base font-semibold">Forecast preferences</h2><p className="mt-1 text-sm text-muted-foreground">Tune how cautious your forecast is. Saving never changes your real accounts.</p></div>
      <form action={saveForecastPreferences} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"><input type="hidden" name="version" value={version} /><input type="hidden" name="requestId" value={crypto.randomUUID()} />
        <label className="text-sm font-medium">Currency<input name="currency" required maxLength={3} defaultValue={preferences.currency_code} className={field} /></label>
        <label className="text-sm font-medium">Safety buffer<input name="buffer" required inputMode="decimal" defaultValue={formatInputAmount(preferences.safety_buffer_minor, preferences.currency_code)} className={field} /></label>
        <label className="text-sm font-medium">Uncertainty (%)<input name="uncertaintyPercent" required inputMode="decimal" pattern="\d{1,3}(\.\d{1,2})?" defaultValue={bpsToPercent(preferences.uncertainty_bps)} className={field} /></label>
        <label className="text-sm font-medium">Extra daily spending<input name="dailySpending" required inputMode="decimal" defaultValue={formatInputAmount(preferences.daily_spending_minor, preferences.currency_code)} className={field} /></label>
        <label className="text-sm font-medium">Account for extra spending<select name="spendingAccountId" defaultValue={preferences.spending_account_id ?? ""} className={field}><option value="">Off (choose an account)</option>{accounts.filter(account => ["checking", "savings", "cash", "wallet"].includes(account.type)).map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
        <label className="text-sm font-medium">Extra spending starts<input name="spendingStartsOn" type="date" defaultValue={preferences.spending_starts_on ?? today} className={field} /></label>
        <div className="space-y-3 sm:col-span-2 lg:col-span-3"><p className="text-sm text-muted-foreground">The safety buffer is cash kept untouched across all accounts. Uncertainty widens the conservative and optimistic band around estimated payments. Zero daily spending turns it off.</p><button className={button}>Save forecast preferences</button></div>
      </form>
      <details><summary className="cursor-pointer text-sm underline">Forecast preference history and undo</summary><ul className="mt-3 space-y-3">{(events ?? []).map(event => <li key={event.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3 text-sm"><div><p>{preferenceSummary(event.after as ForecastPreferences, workspace.locale)}</p><p className="text-muted-foreground">{new Date(event.created_at).toLocaleString(workspace.locale, { timeZone: workspace.timezone })} · {event.undo_of ? "Restoration" : event.undone_at ? "Undone" : "Changed"}</p></div>{!event.undo_of && !event.undone_at && <form action={undoForecastPreferences}><input type="hidden" name="eventId" value={event.id} /><input type="hidden" name="version" value={version} /><button className="text-brand underline">Undo forecast preferences</button></form>}</li>)}</ul>{!events?.length && <p className="mt-3 text-sm text-muted-foreground">No preference changes recorded yet.</p>}</details>
    </section>
  </details>;
}
