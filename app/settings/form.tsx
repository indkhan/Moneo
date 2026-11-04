"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Loader2, Play, Square } from "lucide-react";
import { displayFormat } from "@/lib/display-format";
import { AI_AGENT_KEYS, AI_AGENTS, AI_DATA_SCOPES, INSIGHT_TYPES, VOICES, type WorkspaceSettings } from "@/lib/settings";
import { saveSettings } from "./actions";

const input = "min-h-10 min-w-0 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm font-normal text-foreground";
const card = "scroll-mt-20 space-y-4 rounded-xl border border-border bg-card p-6";
const legend = "px-2 text-base font-semibold";
const label = "grid gap-1.5 text-sm font-medium";
const help = "text-sm text-muted-foreground";
const scopeDescriptions = { accounts: "Account names and dated balances", transactions: "Booked transactions, categories and spending evidence",
  planning: "Goals, budgets and forecast assumptions", imports: "Headers and up to eight source rows for import mapping" };

const LOCALES = [["en-GB", "English (United Kingdom)"], ["en-US", "English (United States)"], ["en-IE", "English (Ireland)"], ["de-DE", "German (Germany)"], ["de-AT", "German (Austria)"], ["de-CH", "German (Switzerland)"],
  ["fr-FR", "French (France)"], ["es-ES", "Spanish (Spain)"], ["it-IT", "Italian (Italy)"], ["nl-NL", "Dutch (Netherlands)"], ["pt-PT", "Portuguese (Portugal)"], ["pl-PL", "Polish (Poland)"], ["sv-SE", "Swedish (Sweden)"], ["tr-TR", "Turkish (Turkey)"], ["ur-PK", "Urdu (Pakistan)"]];
const muteLabels: Partial<Record<(typeof INSIGHT_TYPES)[number], string>> = { asset_debt: "asset and debt changes", upcoming_obligations: "upcoming payments" };

/** The voice choice for calls, with a short sample of whichever voice is selected. */
function VoicePicker({ value }: { value: WorkspaceSettings["voice"] }) {
  const [voice, setVoice] = useState(value);
  const [state, setState] = useState<"idle" | "loading" | "playing" | "failed">("idle");
  const audio = useRef<HTMLAudioElement | null>(null);
  const stop = () => { audio.current?.pause(); audio.current = null; setState("idle"); };
  // Leaving Settings must not leave a sample talking.
  useEffect(() => () => audio.current?.pause(), []);
  async function play() {
    if (state === "playing") return stop();
    audio.current?.pause();
    setState("loading");
    try {
      const clip = new Audio(`/api/voice/sample?${new URLSearchParams({ voice })}`);
      audio.current = clip;
      clip.onended = () => setState("idle");
      await clip.play();
      setState("playing");
    } catch { setState("failed"); }
  }
  return <div className="grid gap-1.5 text-sm font-medium"><label htmlFor="voice">Call voice</label>
    <div className="flex gap-2">
      <select id="voice" name="voice" className={input} value={voice} onChange={event => { stop(); setVoice(event.target.value as typeof voice); }}>{VOICES.map(name => <option key={name} value={name}>{name[0].toUpperCase() + name.slice(1)}</option>)}</select>
      <button type="button" onClick={() => void play()} disabled={state === "loading"} className="inline-flex min-h-10 shrink-0 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ai disabled:opacity-60">
        {state === "loading" ? <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : state === "playing" ? <Square className="size-4 text-ai" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
        {state === "loading" ? "Loading…" : state === "playing" ? "Stop sample" : "Play sample"}</button>
    </div>
    {/* Only present on failure: an always-mounted empty status would match every page-wide status lookup (and the specs') beside "Preferences saved". */}
    {state === "failed" && <span role="alert" className="text-sm font-normal text-danger">Couldn’t play the sample. Check your sound and try again.</span>}</div>;
}

export function SettingsForm({ settings, currency, timeZones }: { settings: WorkspaceSettings; currency: string; timeZones: string[] }) {
  const [state, action, pending] = useActionState(saveSettings, {});
  const [dirty, setDirty] = useState(false);
  const [locale, setLocale] = useState(settings.locale);
  const form = useRef<HTMLFormElement>(null);
  const unsaved = dirty || !!state.error;
  const invalid = (name: string) => state.field === name ? { "aria-invalid": true, "aria-describedby": "settings-error" } : {};
  // The browser's own prompt covers closing and reloading; in-app links are not interceptable in the App Router.
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);
  // Take the person to the field that failed, even inside the closed Advanced section.
  useEffect(() => {
    const field = state.field && form.current?.elements.namedItem(state.field);
    if (!(field instanceof HTMLElement)) return;
    field.closest("details")?.setAttribute("open", "");
    field.focus();
  }, [state]);
  const zones = timeZones.includes(settings.timezone) ? timeZones : [settings.timezone, ...timeZones];
  const locales = LOCALES.some(([code]) => code === settings.locale) ? LOCALES : [[settings.locale, settings.locale], ...LOCALES];
  const example = displayFormat(locale);
  // React also resets uncontrolled fields when an action returns a validation error.
  return <form ref={form} action={action} onChange={() => setDirty(true)} onSubmit={() => setDirty(false)} onReset={event => event.preventDefault()} className="space-y-8">
    <fieldset id="display" className={card}><legend className={legend}>Display and calendar</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={label}>Display currency<input className={`${input} uppercase`} name="display_currency" defaultValue={currency} pattern="[A-Za-z]{3}" title="Three letters, such as EUR" maxLength={3} required {...invalid("display_currency")} /></label>
        <label className={label}>Timezone<select className={input} name="timezone" defaultValue={settings.timezone} {...invalid("timezone")}>{zones.map(zone => <option key={zone} value={zone}>{zone.replaceAll("_", " ")}</option>)}</select></label>
        <label className={label}>Date and number locale<select className={input} name="locale" defaultValue={settings.locale} onChange={event => setLocale(event.target.value)} {...invalid("locale")}>{locales.map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></label>
        <label className={label}>Appearance<select className={input} name="theme" defaultValue={settings.theme}><option value="system">Follow device</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
      </div><p className={help}>Dates and numbers will look like {example.longDate("2026-01-31")} and {example.money(123456, currency)}.</p>
      <p className={help}>Totals are converted to your display currency using the rates available. Your original currencies and amounts are never changed. The app is available in English only.</p>
    </fieldset>
    <fieldset id="ai" className={card}><legend className={legend}>AI and your data</legend>
      <p className={help}>Choose which of your data the AI may use. Secrets are never sent.</p>
      <VoicePicker value={settings.voice} />
      <details className="text-sm text-muted-foreground"><summary className="cursor-pointer">More details</summary><p className="mt-2">OpenAI or OpenRouter (depending on the model) receives your prompts and only the enabled data needed for the task. Chat never receives raw statement files. Import mapping may send column headers and up to eight sample rows. Usage is billed to the matching API key.</p></details>
      <div className="divide-y divide-border">{AI_DATA_SCOPES.map(scope => <label key={scope} className="flex items-start gap-3 py-3 text-sm"><input type="checkbox" className="mt-1 size-4" name="ai_data_scopes" value={scope} defaultChecked={settings.ai_data_scopes.includes(scope)} /><span><strong className="block capitalize">{scope}</strong><span className="text-muted-foreground">{scopeDescriptions[scope]}</span></span></label>)}</div>
      <details className="text-sm"><summary className="cursor-pointer font-medium">Advanced: choose AI models</summary><div className="mt-3 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">{AI_AGENT_KEYS.map(agent => <label key={agent} className={label}>{AI_AGENTS[agent].label} model
        <input className={input} {...invalid(`model:${agent}`)} name={`model:${agent}`} defaultValue={settings.ai_models[agent] ?? ""} placeholder={agent === "voice_call" ? "Same as the chat assistant" : AI_AGENTS[agent].model} maxLength={200} autoComplete="off" spellCheck={false} /></label>)}</div>
      <p className={help}>Type an OpenAI model ID (gpt-6.1-sol) or an OpenRouter one (vendor/model, e.g. nvidia/nemotron-3.5-lightning:free), or leave blank for the default shown. A changed model is tested before saving. Voice call follows the chat assistant unless you pick a faster model for it.</p>
      </div></details>
    </fieldset>
    <fieldset id="insights" className={card}><legend className={legend}>Insights and summaries</legend>
      <p className={help}>Mute the insight types you do not want to see.</p>
      <div className="grid gap-3 sm:grid-cols-2">{INSIGHT_TYPES.map(type => <label key={type} className="flex items-center gap-2 text-sm"><input type="checkbox" name="muted_insight_types" value={type} defaultChecked={settings.muted_insight_types.includes(type)} /><span>Mute {muteLabels[type] ?? type.replaceAll("_", " ")}</span></label>)}</div>
      <div className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1.5 text-sm font-medium">In-app summary preference<select className={input} name="summary_cadence" defaultValue={settings.summary_cadence}><option value="none">Off</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label><label className={label}>Preferred local time<input className={input} type="time" name="summary_time" defaultValue={settings.summary_time} required {...invalid("summary_time")} /></label></div>
      <p className={help}>Summaries appear in the Activity log and may arrive up to a day late.</p>
    </fieldset>
    {/* Kept in view while scrolling a long form, above the phone's bottom bar. */}
    <div className="sticky bottom-20 z-10 space-y-2 rounded-xl border border-border bg-card p-3 shadow-sm lg:bottom-4">
      {state.error && !pending && <p id="settings-error" role="alert" className="rounded-lg border border-danger/40 bg-danger-soft p-3 text-sm text-danger">{state.error}<span className="block">Your previous settings stay active until this saves.</span></p>}
      <div className="flex flex-wrap items-center gap-3">
        <button disabled={pending} className="min-h-10 rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60">{pending ? "Saving…" : "Save preferences"}</button>
        {pending ? <span className="text-sm text-muted-foreground">A changed AI model is tested first, which can take a few seconds.</span>
          : dirty ? <span className="text-sm text-warning">Unsaved changes</span>
          : state.saved ? <p role="status" className="text-sm text-success">Preferences saved.</p> : null}
      </div>
    </div>
  </form>;
}
