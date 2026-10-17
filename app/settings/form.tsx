"use client";

import { useActionState } from "react";
import { AI_AGENT_KEYS, AI_AGENTS, AI_DATA_SCOPES, INSIGHT_TYPES, type WorkspaceSettings } from "@/lib/settings";
import { saveSettings } from "./actions";

const input = "min-h-10 min-w-0 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm font-normal text-foreground";
const card = "scroll-mt-20 space-y-4 rounded-xl border border-border bg-card p-6";
const legend = "px-2 text-base font-semibold";
const label = "grid gap-1.5 text-sm font-medium";
const help = "text-sm text-muted-foreground";
const scopeDescriptions = { accounts: "Account names and dated balances", transactions: "Booked transactions, categories and spending evidence",
  planning: "Goals, budgets and forecast assumptions", imports: "Headers and up to eight source rows for import mapping" };

export function SettingsForm({ settings, currency }: { settings: WorkspaceSettings; currency: string }) {
  const [state, action, pending] = useActionState(saveSettings, {});
  // React also resets uncontrolled fields when an action returns a validation error.
  return <form action={action} onReset={event => event.preventDefault()} className="space-y-8">
    <fieldset id="display" className={card}><legend className={legend}>Display and calendar</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={label}>Display currency<input className={input} name="display_currency" defaultValue={currency} pattern="[A-Z]{3}" maxLength={3} required /></label>
        <label className={label}>Timezone<input className={input} name="timezone" defaultValue={settings.timezone} maxLength={100} required list="timezones" /><datalist id="timezones"><option>Europe/Berlin</option><option>Europe/London</option><option>America/New_York</option><option>UTC</option></datalist></label>
        <label className={label}>Date and number locale<input className={input} name="locale" defaultValue={settings.locale} maxLength={50} required /></label>
        <label className={label}>Appearance<select className={input} name="theme" defaultValue={settings.theme}><option value="system">Follow device</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
      </div><p className={help}>Your original currencies and amounts are never changed. The app is available in English only.</p>
    </fieldset>
    <fieldset id="ai" className={card}><legend className={legend}>AI and your data</legend>
      <p className={help}>Choose which of your data the AI may use. Secrets are never sent.</p>
      <div className="grid gap-3 sm:grid-cols-2">{AI_AGENT_KEYS.map(agent => <label key={agent} className={label}>{AI_AGENTS[agent].label} model
        <input className={input} name={`model:${agent}`} defaultValue={settings.ai_models[agent] ?? ""} placeholder={AI_AGENTS[agent].model} maxLength={200} autoComplete="off" spellCheck={false} /></label>)}</div>
      <p className={help}>Type any OpenAI model ID, or leave blank for the default shown. A changed model is tested before saving.</p>
      <details className="text-sm text-muted-foreground"><summary className="cursor-pointer">More details</summary><p className="mt-2">OpenAI receives your prompts and only the enabled data needed for the task. Chat never receives raw statement files. Import mapping may send column headers and up to eight sample rows. Usage is billed to the configured OpenAI API key.</p></details>
      <div className="divide-y divide-border">{AI_DATA_SCOPES.map(scope => <label key={scope} className="flex items-start gap-3 py-3 text-sm"><input type="checkbox" className="mt-1 size-4" name="ai_data_scopes" value={scope} defaultChecked={settings.ai_data_scopes.includes(scope)} /><span><strong className="block capitalize">{scope}</strong><span className="text-muted-foreground">{scopeDescriptions[scope]}</span></span></label>)}</div>
    </fieldset>
    <fieldset id="insights" className={card}><legend className={legend}>Insights and summaries</legend>
      <p className={help}>Mute the insight types you do not want to see.</p>
      <div className="grid gap-3 sm:grid-cols-2">{INSIGHT_TYPES.map(type => <label key={type} className="flex items-center gap-2 text-sm"><input type="checkbox" name="muted_insight_types" value={type} defaultChecked={settings.muted_insight_types.includes(type)} /><span>Mute {type.replaceAll("_", " ")}</span></label>)}</div>
      <div className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1.5 text-sm font-medium">In-app summary preference<select className={input} name="summary_cadence" defaultValue={settings.summary_cadence}><option value="none">Off</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label><label className={label}>Preferred local time<input className={input} type="time" name="summary_time" defaultValue={settings.summary_time} required /></label></div>
      <p className={help}>Summaries appear in Activity and may arrive up to a day late.</p>
    </fieldset>
    {state.error && <p role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900">{state.error}</p>}
    {state.saved && <p role="status" className="text-sm text-emerald-700 dark:text-emerald-300">Preferences saved.</p>}
    <button disabled={pending} className="min-h-10 rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60">{pending ? "Saving…" : "Save preferences"}</button>
  </form>;
}
