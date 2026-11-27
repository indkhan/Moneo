"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown, Loader2, Play, Square } from "lucide-react";
import { CurrencySelect } from "@/components/currency-select";
import { displayFormat } from "@/lib/display-format";
import { AI_AGENT_KEYS, AI_AGENTS, AI_DATA_SCOPES, deviceTimeZone, SPEECH_ENGINES, VOICES } from "@/lib/workspace-settings-options";
import type { WorkspaceSettings } from "@/lib/settings";
import { INSIGHT_TYPES } from "@/lib/insight-types";
import { SPEECH_ENGINE_LABELS } from "@/lib/ai/speech/engine";
import { SaveError, SaveStatus, useSettingsSection } from "./autosave";
import { SpeechModels } from "./speech-models";
import { SpeechOpenRouter } from "./speech-openrouter";
import type { AiSource } from "@/lib/ai/chatgpt";
import { useAiAccess } from "@/lib/ai/use-ai-access";
import { connectedDefault, modelOptions, type ModelConnections } from "@/lib/ai/model-options";
import { VoiceKeyToast } from "@/components/voice-key-toast";

const input = "min-h-10 min-w-0 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm font-normal text-foreground";
const label = "grid gap-1.5 text-sm font-medium";
const help = "text-sm text-muted-foreground";
const scopeDescriptions = { accounts: "Account names and dated balances", transactions: "Booked transactions, categories and spending evidence",
  planning: "Goals, budgets and forecast assumptions", imports: "Headers and up to eight source rows for import mapping" };

const LOCALES = [["en-GB", "English (United Kingdom)"], ["en-US", "English (United States)"], ["en-IE", "English (Ireland)"], ["de-DE", "German (Germany)"], ["de-AT", "German (Austria)"], ["de-CH", "German (Switzerland)"],
  ["fr-FR", "French (France)"], ["es-ES", "Spanish (Spain)"], ["it-IT", "Italian (Italy)"], ["nl-NL", "Dutch (Netherlands)"], ["pt-PT", "Portuguese (Portugal)"], ["pl-PL", "Polish (Poland)"], ["sv-SE", "Swedish (Sweden)"], ["tr-TR", "Turkish (Turkey)"], ["ur-PK", "Urdu (Pakistan)"]];
const insightLabels: Partial<Record<(typeof INSIGHT_TYPES)[number], string>> = { asset_debt: "asset and debt changes", upcoming_obligations: "upcoming payments" };

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

function VoicePicker({ value, onChange }: { value: WorkspaceSettings["voice"]; onChange: () => void }) {
  const selectId = useId();
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
  return <div className="grid gap-1.5 text-sm font-medium"><label htmlFor={selectId}>Voice</label>
    <div className="flex gap-2">
      <select id={selectId} name="voice" className={input} value={voice} onChange={event => { stop(); setVoice(event.target.value as typeof voice); onChange(); }}>{VOICES.map(name => <option key={name} value={name}>{name[0].toUpperCase() + name.slice(1)}</option>)}</select>
      <button type="button" onClick={() => void play()} disabled={state === "loading"} className="inline-flex min-h-10 shrink-0 items-center gap-2 rounded-lg border border-border px-3 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ai disabled:opacity-60">
        {state === "loading" ? <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" /> : state === "playing" ? <Square className="size-4 text-ai" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
        {state === "loading" ? "Loading…" : state === "playing" ? "Stop sample" : "Play sample"}</button>
    </div>
    {needsKey && <VoiceKeyToast onDismiss={() => setNeedsKey(false)} />}
    {state === "failed" && <span role="alert" className="text-sm font-normal text-danger">{"Couldn’t play the sample. Check your sound and try again."}</span>}</div>;
}

const neverChanges = () => () => {};
const engineDescriptions: Record<(typeof SPEECH_ENGINES)[number], string> = {
  openai: "Sends your recording to OpenAI. Needs an OpenAI API key.",
  local: "Runs on this computer after a one-time download. Your recording never leaves it.",
  openrouter: "Sends your recording to a model you pick on OpenRouter. Needs an OpenRouter key.",
};
type SectionStatus = Parameters<typeof SaveStatus>[0]["status"];

export function Section({ id, title, intro, status, children }: { id: string; title: string; intro: React.ReactNode; status?: SectionStatus; children: React.ReactNode }) {
  return <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-20 space-y-4 rounded-xl border border-border bg-card p-6">
    <div><div className="flex flex-wrap items-center gap-x-3"><h2 id={`${id}-title`} className="text-base font-semibold">{title}</h2>{status !== undefined && <SaveStatus status={status} />}</div>
      <p className={`mt-1 ${help}`}>{intro}</p></div>
    {children}
    {status && <SaveError status={status} />}
  </section>;
}

function Toggle({ label: text, description, checked, onChange, name, value }: { label: string; description?: string; checked: boolean; onChange: (checked: boolean) => void; name?: string; value?: string }) {
  return <label className="flex cursor-pointer items-start justify-between gap-4 py-3 text-sm">
    <span><span className="block font-medium">{text}</span>{description && <span className="text-muted-foreground">{description}</span>}</span>
    <input type="checkbox" role="switch" name={name} value={value} checked={checked} onChange={event => onChange(event.target.checked)}
      className="relative mt-0.5 h-6 w-11 shrink-0 cursor-pointer appearance-none rounded-full bg-muted-foreground/30 transition-colors before:absolute before:left-0.5 before:top-0.5 before:size-5 before:rounded-full before:bg-background before:shadow before:transition-transform checked:bg-primary checked:before:translate-x-5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ai" />
  </label>;
}

export function GeneralSettings({ settings, currency, timeZones }: { settings: WorkspaceSettings; currency: string; timeZones: string[] }) {
  const { form, changed, invalid, status } = useSettingsSection("general");
  const [zone, setZone] = useState(settings.timezone);
  const deviceZone = useSyncExternalStore(neverChanges, deviceTimeZone, () => null);
  const [locale, setLocale] = useState(settings.locale);
  const [shownCurrency, setShownCurrency] = useState(currency);
  const zones = timeZones.includes(settings.timezone) ? timeZones : [settings.timezone, ...timeZones];
  const locales = LOCALES.some(([code]) => code === settings.locale) ? LOCALES : [[settings.locale, settings.locale], ...LOCALES];
  const example = displayFormat(locale);
  return <Section id="general" title="General" status={status}
    intro={<>Dates and numbers look like {example.longDate("2026-01-31")} and {example.money(123456, shownCurrency)}. Totals are converted to your display currency; original amounts never change.</>}>
    <form {...form} className="grid gap-3 sm:grid-cols-2">
      <label className={label}>Display currency<CurrencySelect name="display_currency" label="Display currency" defaultValue={currency} locale={settings.locale} onChange={code => { setShownCurrency(code); changed(); }} /></label>
      <div><label className={label}>Timezone<select className={input} name="timezone" value={zone} onChange={event => setZone(event.target.value)} {...invalid("timezone")}>{zones.map(name => <option key={name} value={name}>{name.replaceAll("_", " ")}</option>)}</select></label>
        {deviceZone && deviceZone !== zone && zones.includes(deviceZone) && <button type="button" className="mt-1 text-xs font-medium text-brand hover:underline" onClick={() => { setZone(deviceZone); changed(); }}>Use this device&apos;s timezone ({deviceZone.replaceAll("_", " ")})</button>}</div>
      <label className={label}>Date and number format<select className={input} name="locale" defaultValue={settings.locale} onChange={event => setLocale(event.target.value)} {...invalid("locale")}>{locales.map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></label>
      <label className={label}>Appearance<select className={input} name="theme" defaultValue={settings.theme}><option value="system">Follow device</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
    </form>
  </Section>;
}

export function AiModelSettings({ settings, aiSource, connections }: { settings: WorkspaceSettings; aiSource: AiSource; connections: ModelConnections }) {
  const { form, changed, invalid, status } = useSettingsSection("ai");
  const [scopes, setScopes] = useState<string[]>(settings.ai_data_scopes);
  return <Section id="ai" title="Models and data" intro="Which model answers, and which of your data the AI may read. Secrets are never sent." status={status}>
    <form {...form} className="space-y-4">
      <div className={label}><label htmlFor="model:default">Default model</label>
        <ModelPicker onChange={() => changed()} invalid={invalid("model:default")} name="model:default" initial={settings.ai_models.default ?? ""}
          placeholder={connectedDefault("chat", connections, aiSource === "claude")} options={modelOptions(connections)} />
        <p className={`${help} font-normal`}>Leave blank to use the one shown.</p>
      </div>
      <details open={AI_AGENT_KEYS.some(agent => Boolean(settings.ai_models[agent]))} className="text-sm"><summary className="cursor-pointer font-medium">Advanced: a model per task</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">{AI_AGENT_KEYS.map(agent => <div key={agent} className={label}>
          <label htmlFor={`model:${agent}`}>{AI_AGENTS[agent].label} model</label>
          <ModelPicker onChange={() => changed()} invalid={invalid(`model:${agent}`)} name={`model:${agent}`} initial={settings.ai_models[agent] ?? ""}
            placeholder="Use default model" options={modelOptions(connections)} />
        </div>)}</div>
        <p className={`mt-2 ${help}`}>OpenRouter IDs include vendor/model.</p>
      </details>
      <div className="divide-y divide-border border-t border-border">{AI_DATA_SCOPES.map(scope => <Toggle key={scope} name="ai_data_scopes" value={scope} label={`Let AI read ${scope}`} description={scopeDescriptions[scope]}
        checked={scopes.includes(scope)} onChange={on => setScopes(current => on ? [...current, scope] : current.filter(item => item !== scope))} />)}</div>
      <details className={help}><summary className="cursor-pointer">More details</summary><p className="mt-2">OpenAI, Anthropic or OpenRouter (depending on the model) receives your prompts and only the data switched on above that the task needs. Chat never receives raw statement files. Import mapping may send column headers and up to eight sample rows. Usage is billed to the matching API key, or counts toward your ChatGPT or Claude plan.</p></details>
    </form>
  </Section>;
}

export function VoiceSettings({ settings, connections }: { settings: WorkspaceSettings; connections: ModelConnections }) {
  const { form, changed, status } = useSettingsSection("voice");
  const [speechEngine, setSpeechEngine] = useState(settings.speech_engine);
  return <Section id="voice" title="Voice" intro="How Moneo sounds on a call, and how it hears you when you talk in chat." status={status}>
    <form {...form} className="space-y-6">
      <div className="space-y-2"><h3 className="text-sm font-semibold">Voice for calls</h3>
        <VoicePicker value={settings.voice} onChange={() => changed()} />
        <p className={help}>Calls always run through OpenAI and need an OpenAI API key.</p>
      </div>
      <fieldset className="space-y-3"><legend className="text-sm font-semibold">When you speak in chat</legend>
        <p className={help}>Who turns your words into text when you tap the microphone.</p>
        <div className="divide-y divide-border rounded-lg border border-border">{SPEECH_ENGINES.map(engine => {
          const locked = engine === "openrouter" && !connections.openrouter && engine !== settings.speech_engine;
          return <label key={engine} className={`flex items-start gap-3 p-3 text-sm ${locked ? "opacity-60" : "cursor-pointer"}`}>
            <input type="radio" className="mt-1 size-4" name="speech_engine" value={engine} checked={speechEngine === engine} disabled={locked} onChange={() => setSpeechEngine(engine)} />
            <span><strong className="block font-medium">{SPEECH_ENGINE_LABELS[engine]}</strong><span className="text-muted-foreground">{engineDescriptions[engine]}{locked ? " Add one under AI access first." : ""}</span></span>
          </label>;
        })}</div>
        <p className={help}>If your choice can&apos;t run, Moneo falls back to OpenAI when you have a key.</p>
      </fieldset>
      <SpeechOpenRouter initial={settings.speech_openrouter_model} hidden={speechEngine !== "openrouter"} onChange={() => changed()} />
      <SpeechModels initial={settings.speech_local_model} hidden={speechEngine !== "local"} onChange={() => changed()} />
    </form>
  </Section>;
}

export function InsightSwitches({ settings, children }: { settings: WorkspaceSettings; children: React.ReactNode }) {
  const { form, invalid, status } = useSettingsSection("insights");
  const [muted, setMuted] = useState<string[]>(settings.muted_insight_types);
  return <Section id="insights" title="Insights" intro="Worked out in the app from your data; no AI provider sees them." status={status}>
    <form {...form} className="space-y-4">
      {muted.map(type => <input key={type} type="hidden" name="muted_insight_types" value={type} />)}
      <div className="grid gap-x-8 divide-y divide-border sm:grid-cols-2 sm:divide-y-0">{INSIGHT_TYPES.map(type => <Toggle key={type} label={`Show ${insightLabels[type] ?? type.replaceAll("_", " ")}`}
        checked={!muted.includes(type)} onChange={on => setMuted(current => on ? current.filter(item => item !== type) : [...current, type])} />)}</div>
      <div className="grid gap-3 border-t border-border pt-4 sm:grid-cols-2">
        <label className={label}>Summary in the Activity log<select className={input} name="summary_cadence" defaultValue={settings.summary_cadence}><option value="none">Off</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></select></label>
        <label className={label}>At about<input className={input} type="time" name="summary_time" defaultValue={settings.summary_time} required {...invalid("summary_time")} /></label>
      </div>
    </form>
    {children}
  </Section>;
}

