"use client";

import { useActionState } from "react";
import { AI_DATA_SCOPES, INSIGHT_TYPES, type WorkspaceSettings } from "@/lib/settings";
import { saveSettings } from "./actions";

const input = "min-h-10 min-w-0 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground";
const scopeDescriptions = { accounts: "Account names and dated balances", transactions: "Booked transactions, categories and spending evidence",
  planning: "Goals, budgets and forecast assumptions", imports: "Headers and up to eight source rows for import mapping" };

export function SettingsForm({ settings, currency, models, defaultModel, catalogueError }: {
  settings: WorkspaceSettings; currency: string; models: { id: string; name: string }[]; defaultModel: string; catalogueError?: string;
}) {
  const [state, action, pending] = useActionState(saveSettings, {});
  // React also resets uncontrolled fields when an action returns a validation error.
  return <form action={action} onReset={event => event.preventDefault()} className="space-y-7">
    <fieldset className="rounded-xl border border-border bg-card p-5"><legend className="px-2 text-lg font-semibold">Display and calendar</legend>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="grid gap-1 text-sm">Display currency<input className={input} name="display_currency" defaultValue={currency} pattern="[A-Z]{3}" maxLength={3} required /></label>
        <label className="grid gap-1 text-sm">Timezone<input className={input} name="timezone" defaultValue={settings.timezone} maxLength={100} required list="timezones" /><datalist id="timezones"><option>Europe/Berlin</option><option>Europe/London</option><option>America/New_York</option><option>UTC</option></datalist></label>
        <label className="grid gap-1 text-sm">Date and number locale<input className={input} name="locale" defaultValue={settings.locale} maxLength={50} required /></label>
        <label className="grid gap-1 text-sm">Appearance<select className={input} name="theme" defaultValue={settings.theme}><option value="system">Follow device</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
      </div><p className="mt-3 text-sm text-muted-foreground">Original currencies and amounts stay intact. Currency comparisons require dated conversion evidence. The interface remains in English.</p>
    </fieldset>
    <fieldset className="rounded-xl border border-border bg-card p-5"><legend className="px-2 text-lg font-semibold">AI and your data</legend>
      <label className="grid gap-1 text-sm">Free OpenRouter model<select className={input} name="openrouter_model" defaultValue={settings.openrouter_model ?? ""}>
        <option value="">Configured default ({defaultModel})</option>
        {settings.openrouter_model && !models.some(model => model.id === settings.openrouter_model) && <option value={settings.openrouter_model}>{settings.openrouter_model} · verification unavailable</option>}
        {models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
      </select></label>
      {catalogueError && <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">{catalogueError}</p>}
      <p className="mt-3 text-sm text-muted-foreground">OpenRouter receives your prompts and only the enabled financial evidence needed for the task. Ordinary chat does not receive raw statement files. Import mapping may send headers and up to eight sample rows. Secrets are never sent. Models are verified as free before use; unavailable or paid models are refused.</p>
      <div className="mt-4 divide-y divide-border">{AI_DATA_SCOPES.map(scope => <label key={scope} className="flex items-start gap-3 py-3 text-sm"><input type="checkbox" className="mt-1 size-4" name="ai_data_scopes" value={scope} defaultChecked={settings.ai_data_scopes.includes(scope)} /><span><strong className="block capitalize">{scope}</strong><span className="text-muted-foreground">{scopeDescriptions[scope]}</span></span></label>)}</div>
    </fieldset>
    <fieldset className="rounded-xl border border-border bg-card p-5"><legend className="px-2 text-lg font-semibold">Insights and summaries</legend>
      <p className="text-sm text-muted-foreground">Mute insight types you do not want to see. Evidence and data-quality limits still apply.</p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">{INSIGHT_TYPES.map(type => <label key={type} className="flex items-center gap-2 text-sm"><input type="checkbox" name="muted_insight_types" value={type} defaultChecked={settings.muted_insight_types.includes(type)} /><span>Mute {type.replaceAll("_", " ")}</span></label>)}</div>
      <div className="mt-5 grid gap-4 sm:grid-cols-2"><label className="grid gap-1 text-sm">In-app summary preference<select className={input} name="summary_cadence" defaultValue={settings.summary_cadence}><option value="none">Off</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label><label className="grid gap-1 text-sm">Preferred local time<input className={input} type="time" name="summary_time" defaultValue={settings.summary_time} required /></label></div>
      <p className="mt-3 text-sm text-muted-foreground">Summaries appear in Activity. A daily check runs due weekly or monthly summaries when scheduling is configured; delivery may be delayed by a day.</p>
    </fieldset>
    {state.error && <p role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800">{state.error}</p>}
    {state.saved && <p role="status" className="text-sm text-emerald-700 dark:text-emerald-300">Preferences saved.</p>}
    <button disabled={pending} className="min-h-10 rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60">{pending ? "Saving…" : "Save preferences"}</button>
  </form>;
}
