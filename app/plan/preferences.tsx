import { requireWorkspace } from "@/lib/auth";
import type { ForecastPreferences } from "@/lib/finance/preferences";
import { formatInputAmount, formatMoney } from "@/lib/finance/format";
import { saveForecastPreferences, undoForecastPreferences } from "./preference-actions";

export async function ForecastPreferenceEditor({ preferences, version, accounts, today }: { preferences: ForecastPreferences; version: number; accounts: { id: string; name: string; type: string }[]; today: string }) {
  const { supabase, workspace } = await requireWorkspace();
  const { data: events, error } = await supabase.from("forecast_preference_events").select("id, before, after, undo_of, undone_at, created_at").eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(50);
  if (error) throw error;
  const field = "mt-1 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm";
  return <section id="forecast-preferences" className="space-y-4 rounded-xl border border-border bg-card p-6"><div><h2 className="text-base font-semibold">Forecast preferences</h2><p className="mt-1 text-sm text-muted-foreground">Tune how cautious your forecast is.</p></div>
    <form action={saveForecastPreferences} className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"><input type="hidden" name="version" value={version} /><input type="hidden" name="requestId" value={crypto.randomUUID()} />
      <label className="text-sm font-medium">Currency<input name="currency" required maxLength={3} defaultValue={preferences.currency_code} className={field} /></label>
      <label className="text-sm font-medium">Safety buffer<input name="buffer" required inputMode="decimal" defaultValue={formatInputAmount(preferences.safety_buffer_minor, preferences.currency_code)} className={field} /></label>
      <label className="text-sm font-medium">Uncertainty (1000 = 10%)<input name="uncertaintyBps" type="number" required min={0} max={10000} defaultValue={preferences.uncertainty_bps} className={field} /></label>
      <label className="text-sm font-medium">Extra daily spending<input name="dailySpending" required inputMode="decimal" defaultValue={formatInputAmount(preferences.daily_spending_minor, preferences.currency_code)} className={field} /></label>
      <label className="text-sm font-medium">Account for extra spending<select name="spendingAccountId" defaultValue={preferences.spending_account_id ?? ""} className={field}><option value="">Off (choose an account)</option>{accounts.filter(account => ["checking", "savings", "cash", "wallet"].includes(account.type)).map(account => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>
      <label className="text-sm font-medium">Extra spending starts<input name="spendingStartsOn" type="date" defaultValue={preferences.spending_starts_on ?? today} className={field} /></label>
      <div className="space-y-3 sm:col-span-2 lg:col-span-3"><p className="text-sm text-muted-foreground">The safety buffer is cash kept untouched across all accounts. Zero turns off extra spending. Saving never changes your real accounts.</p><button className="min-h-10 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground">Save forecast preferences</button></div>
    </form>
    <details><summary className="cursor-pointer text-sm underline">Forecast preference history and undo</summary><ul className="mt-3 space-y-3">{(events ?? []).map(event => { const after = event.after as ForecastPreferences; return <li key={event.id} className="flex flex-wrap items-center justify-between gap-3 rounded border border-border p-3 text-sm"><div><p>Buffer {formatMoney(after.safety_buffer_minor, after.currency_code, workspace.locale)} · extra spending {formatMoney(after.daily_spending_minor, after.currency_code, workspace.locale)} daily · ±{after.uncertainty_bps / 100}%</p><p className="text-sm text-muted-foreground">{new Date(event.created_at).toLocaleString(workspace.locale, { timeZone: workspace.timezone })} · {event.undo_of ? "Restoration" : event.undone_at ? "Undone" : "Changed"}</p></div>{!event.undo_of && !event.undone_at && <form action={undoForecastPreferences}><input type="hidden" name="eventId" value={event.id} /><input type="hidden" name="version" value={version} /><button className="text-brand underline">Undo forecast preferences</button></form>}</li>; })}</ul></details>
  </section>;
}

