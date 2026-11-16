"use client";

import { useActionState, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown, Loader2, Play, Square } from "lucide-react";
import { CurrencySelect } from "@/components/currency-select";
import { displayFormat } from "@/lib/display-format";
import { AI_AGENT_KEYS, AI_AGENTS, AI_DATA_SCOPES, deviceTimeZone, INSIGHT_TYPES, VOICES, type WorkspaceSettings } from "@/lib/settings";
import { saveSettings } from "./actions";
import type { AiSource } from "@/lib/ai/chatgpt";
import { useAiAccess } from "@/lib/ai/use-ai-access";
import { connectedDefault, modelOptions, type ModelConnections } from "@/lib/ai/model-options";
import { VoiceKeyToast } from "@/components/voice-key-toast";

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

function ModelPicker({ name, initial, placeholder, options, invalid, onChange }: { name: string; initial: string; placeholder: string; options: string[]; invalid: object; onChange: () => void }) {
  const [value, setValue] = useState(initial);
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const shown = options.includes(value) ? options : options.filter(model => model.toLowerCase().includes(value.toLowerCase().trim()));
  const choose = (model: string) => { setValue(model); onChange(); setOpen(false); setActive(-1); };
  return <div className="relative" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <div className="relative">
      <input id={name} role="combobox" aria-expanded={open} aria-controls={id} aria-autocomplete="list"
        aria-activedescendant={open && active >= 0 ? `${id}-${active}` : undefined}
        className={`${input} pr-12`} {...invalid} name={name} value={value} placeholder={placeholder}
        maxLength={200} autoComplete="off" spellCheck={false}
        onFocus={() => setOpen(true)}
        onChange={event => { setValue(event.target.value); setOpen(true); setActive(-1); }}
        onKeyDown={event => {
          if (event.key === "Escape") { event.preventDefault(); setOpen(false); }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault(); setOpen(true);
            setActive(index => Math.max(0, Math.min(shown.length - 1, index + (event.key === "ArrowDown" ? 1 : -1))));
          }
          if (event.key === "Enter" && open && shown[active]) { event.preventDefault(); choose(shown[active]); }
        }} />
      <button type="button" aria-label={`Show suggestions for ${name}`} aria-expanded={open} aria-controls={id}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-lg hover:bg-muted"
        onClick={() => { setOpen(!open); setActive(-1); }}><ChevronDown className="size-4" aria-hidden="true" /></button>
    </div>
    {open && <ul id={id} role="listbox" aria-label="Model suggestions" className="absolute z-20 mt-1 max-h-56 w-full overflow-auto rounded-lg border border-border bg-card p-1 text-sm shadow-lg">
      {shown.map((model, index) => <li key={model} id={`${id}-${index}`} role="option" aria-selected={active === index}
        className={`cursor-pointer break-all rounded-md px-3 py-2 hover:bg-muted ${active === index ? "bg-muted" : ""}`}
        onMouseDown={event => { event.preventDefault(); choose(model); }}>{model}</li>)}
      {!shown.length && <li className="px-3 py-2 text-muted-foreground">Use the model ID you typed.</li>}
    </ul>}
  </div>;
}

function VoicePicker({ value }: { value: WorkspaceSettings["voice"] }) {
  const [voice, setVoice] = useState(value);
  const [state, setState] = useState<"idle" | "loading" | "playing" | "failed">("idle");
  const [needsKey, setNeedsKey] = useState(false);
  const audio = useRef<HTMLAudioElement | null>(null);
  const access = useAiAccess();
  const stop = () => { audio.current?.pause(); audio.current = null; setState("idle"); };
  useEffect(() => () => audio.current?.pause(), []);
  async function play() {
    if (state === "playing") return stop();
    if (access?.voice === false) return setNeedsKey(true);
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
    {needsKey && <VoiceKeyToast onDismiss={() => setNeedsKey(false)} />}
    {state === "failed" && <span role="alert" className="text-sm font-normal text-danger">{"Couldn’t play the sample. Check your sound and try again."}</span>}</div>;
}

const neverChanges = () => () => {};

export function SettingsForm({ settings, currency, timeZones, aiSource, connections }: { settings: WorkspaceSettings; currency: string; timeZones: string[]; aiSource: AiSource; connections: ModelConnections }) {
  const [state, action, pending] = useActionState(saveSettings, {});
  const [customize, setCustomize] = useState(AI_AGENT_KEYS.some(agent => Boolean(settings.ai_models[agent])));
  const [dirty, setDirty] = useState(false);
  const [zone, setZone] = useState(settings.timezone);
  const deviceZone = useSyncExternalStore(neverChanges, deviceTimeZone, () => null);
  const [locale, setLocale] = useState(settings.locale);
  const form = useRef<HTMLFormElement>(null);
  const unsaved = dirty || !!state.error;
  const invalid = (name: string) => state.field === name ? { "aria-invalid": true, "aria-describedby": "settings-error" } : {};
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);
  useEffect(() => {
    const named = state.field && form.current?.elements.namedItem(state.field);
    const field = named instanceof HTMLInputElement && named.type === "hidden" ? named.nextElementSibling : named;
    if (!(field instanceof HTMLElement)) return;
    field.closest("details")?.setAttribute("open", "");
    field.focus();
  }, [state]);
  const zones = timeZones.includes(settings.timezone) ? timeZones : [settings.timezone, ...timeZones];
  const locales = LOCALES.some(([code]) => code === settings.locale) ? LOCALES : [[settings.locale, settings.locale], ...LOCALES];
  const example = displayFormat(locale);
  return <form ref={form} action={action} onChange={() => setDirty(true)} onSubmit={() => setDirty(false)} onReset={event => event.preventDefault()} className="space-y-8">
    <fieldset id="display" className={card}><legend className={legend}>Display and calendar</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={label}>Display currency<CurrencySelect name="display_currency" label="Display currency" defaultValue={currency} locale={settings.locale} onChange={() => setDirty(true)} /></label>
        <div><label className={label}>Timezone<select className={input} name="timezone" value={zone} onChange={event => setZone(event.target.value)} {...invalid("timezone")}>{zones.map(name => <option key={name} value={name}>{name.replaceAll("_", " ")}</option>)}</select></label>
          {deviceZone && deviceZone !== zone && zones.includes(deviceZone) && <button type="button" className="mt-1 text-xs font-medium text-brand hover:underline" onClick={() => { setZone(deviceZone); setDirty(true); }}>Use this device&apos;s timezone ({deviceZone.replaceAll("_", " ")})</button>}</div>
        <label className={label}>Date and number locale<select className={input} name="locale" defaultValue={settings.locale} onChange={event => setLocale(event.target.value)} {...invalid("locale")}>{locales.map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></label>
        <label className={label}>Appearance<select className={input} name="theme" defaultValue={settings.theme}><option value="system">Follow device</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
      </div><p className={help}>Dates and numbers will look like {example.longDate("2026-01-31")} and {example.money(123456, currency)}.</p>
      <p className={help}>Totals are converted to your display currency using the rates available. Your original currencies and amounts are never changed. The app is available in English only.</p>
    </fieldset>
    <fieldset id="ai" className={card}><legend className={legend}>AI and your data</legend>
      <p className={help}>Choose which of your data the AI may use. Secrets are never sent.</p>
      <div className="space-y-4 border-t border-border pt-4">
        <div className={label}><label htmlFor="model:default">Default model</label>
          <ModelPicker onChange={() => setDirty(true)} invalid={invalid("model:default")} name="model:default" initial={settings.ai_models.default ?? ""}
            placeholder={connectedDefault("chat", connections, aiSource === "claude")} options={modelOptions(connections)} />
          <p className={help}>Used for every AI task. Type a model ID or choose a suggestion. Leave blank for the default shown.</p>
        </div>
        <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" className="size-4" checked={customize} onChange={event => setCustomize(event.target.checked)} />Customize by task</label>
        <fieldset disabled={!customize} hidden={!customize} className="grid gap-3 sm:grid-cols-2">{AI_AGENT_KEYS.map(agent => <div key={agent} className={label}>
          <label htmlFor={`model:${agent}`}>{AI_AGENTS[agent].label} model</label>
          <ModelPicker onChange={() => setDirty(true)} invalid={invalid(`model:${agent}`)} name={`model:${agent}`} initial={settings.ai_models[agent] ?? ""}
            placeholder="Use default model" options={modelOptions(connections)} />
        </div>)}</fieldset>
        <p className={help}>OpenRouter IDs include vendor/model. Saving does not call the AI provider.</p>
      </div>
      <VoicePicker value={settings.voice} />
      <details className="text-sm text-muted-foreground"><summary className="cursor-pointer">More details</summary><p className="mt-2">OpenAI, Anthropic or OpenRouter (depending on the model) receives your prompts and only the enabled data needed for the task. Chat never receives raw statement files. Import mapping may send column headers and up to eight sample rows. Usage is billed to the matching API key, or counts toward your ChatGPT or Claude plan.</p></details>
      <div className="divide-y divide-border">{AI_DATA_SCOPES.map(scope => <label key={scope} className="flex items-start gap-3 py-3 text-sm"><input type="checkbox" className="mt-1 size-4" name="ai_data_scopes" value={scope} defaultChecked={settings.ai_data_scopes.includes(scope)} /><span><strong className="block capitalize">{scope}</strong><span className="text-muted-foreground">{scopeDescriptions[scope]}</span></span></label>)}
        <label className="flex items-start gap-3 py-3 text-sm"><input type="checkbox" className="mt-1 size-4" name="artifact_scalable_data" value="live" defaultChecked={settings.artifact_scalable_data === "live"} /><span><strong className="block">Live Scalable data in artifacts</strong><span className="text-muted-foreground">Off: artifact Pages and Home cards show your Scalable portfolio as of the last sync, the same figures as Wealth. On: they read Scalable live each time they open, with current prices and quotes and charts for any security, but they load slower and show an error when Scalable can&apos;t be reached.</span></span></label></div>
    </fieldset>
    <fieldset id="insights" className={card}><legend className={legend}>Insights and summaries</legend>
      <p className={help}>Mute the insight types you do not want to see.</p>
      <div className="grid gap-3 sm:grid-cols-2">{INSIGHT_TYPES.map(type => <label key={type} className="flex items-center gap-2 text-sm"><input type="checkbox" name="muted_insight_types" value={type} defaultChecked={settings.muted_insight_types.includes(type)} /><span>Mute {muteLabels[type] ?? type.replaceAll("_", " ")}</span></label>)}</div>
      <div className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1.5 text-sm font-medium">In-app summary preference<select className={input} name="summary_cadence" defaultValue={settings.summary_cadence}><option value="none">Off</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label><label className={label}>Preferred local time<input className={input} type="time" name="summary_time" defaultValue={settings.summary_time} required {...invalid("summary_time")} /></label></div>
      <p className={help}>Summaries appear in the Activity log and may arrive up to a day late.</p>
    </fieldset>
    <div className="sticky bottom-20 z-10 max-lg:bottom-[calc(4rem+env(safe-area-inset-bottom))] space-y-2 rounded-xl border border-border bg-card p-3 shadow-sm lg:bottom-4">
      {state.error && !pending && <p id="settings-error" role="alert" className="rounded-lg border border-danger/40 bg-danger-soft p-3 text-sm text-danger">{state.error}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <button disabled={pending} className="min-h-10 rounded-lg bg-primary px-5 py-2 text-sm font-medium text-primary-foreground disabled:opacity-60">{pending ? "Saving…" : "Save preferences"}</button>
        {pending ? <span className="text-sm text-muted-foreground">Saving your preferences...</span>
          : dirty ? <span className="text-sm text-warning">Unsaved changes</span>
          : state.saved ? <p role="status" className="text-sm text-success">Preferences saved.</p> : null}
      </div>
    </div>
  </form>;
}
