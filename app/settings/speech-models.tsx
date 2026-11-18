"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, FolderOpen, Loader2, Mic, Square } from "lucide-react";
import { usePolling } from "@/lib/use-polling";
import { LOCAL_SPEECH_MODELS, localModel, modelBytes } from "@/lib/ai/speech/local-models";
import { startModelTrial, type VoiceRecording } from "@/lib/ai/voice-recorder";

type Status = { state: "missing" } | { state: "installed" } | { state: "downloading"; received: number; total: number } | { state: "failed"; error: string; received: number; total: number };
type Overview = { supported: boolean; desktop: boolean; folder: string; models: { id: string; status: Status }[]; custom?: { family: string; dtype: string } | null };
type Trial = { state: "idle" } | { state: "recording"; level: number } | { state: "working" } | { state: "heard"; text: string; seconds: number } | { state: "failed"; error: string };

const CUSTOM = "custom";
const button = "inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted disabled:opacity-60";
const megabytes = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;

async function overview(folder?: string): Promise<Overview> {
  const response = await fetch(`/api/voice/models${folder ? `?folder=${encodeURIComponent(folder)}` : ""}`, { cache: "no-store" });
  if (!response.ok) throw new Error("Model details are unavailable. Reload the page to try again.");
  return response.json();
}

export function SpeechModels({ initial, hidden, onChange }: { initial: string | null; hidden: boolean; onChange: () => void }) {
  const [info, setInfo] = useState<Overview | null>(null);
  const [loadError, setLoadError] = useState("");
  const [selected, setSelected] = useState(initial && localModel(initial) ? initial : initial ? CUSTOM : "");
  const [customPath, setCustomPath] = useState(initial && !localModel(initial) ? initial : "");
  const [custom, setCustom] = useState<Overview["custom"]>(undefined);
  const [trial, setTrial] = useState<Trial>({ state: "idle" });
  const recording = useRef<VoiceRecording | null>(null);
  const value = selected === CUSTOM ? customPath.trim() : selected;

  const refresh = useCallback(() => overview().then(next => { setInfo(next); setLoadError(""); }, (cause: Error) => setLoadError(cause.message)), []);
  const opened = useRef(false);
  useEffect(() => {
    if (hidden || opened.current) return;
    opened.current = true;
    void refresh();
    if (customPath) overview(customPath).then(next => setCustom(next.custom ?? null), () => setCustom(null));
  }, [hidden, customPath, refresh]);
  const downloading = info?.models.some(model => model.status.state === "downloading");
  usePolling(refresh, 1000, !!downloading);
  useEffect(() => () => recording.current?.cancel(), []);

  const checkFolder = (folder: string) => {
    setCustom(undefined);
    if (folder.trim()) overview(folder.trim()).then(next => setCustom(next.custom ?? null), () => setCustom(null));
  };
  const choose = (next: string) => { setSelected(next); setTrial({ state: "idle" }); onChange(); };
  const download = async (id: string) => {
    await fetch("/api/voice/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: id }) });
    await refresh();
  };
  const pickFolder = async () => {
    const response = await fetch("/api/voice/models/folder", { method: "POST" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return setLoadError(typeof body?.error === "string" ? body.error : "The folder picker could not open.");
    if (typeof body.folder === "string") { setCustomPath(body.folder); choose(CUSTOM); checkFolder(body.folder); }
  };
  const tryIt = async () => {
    if (trial.state === "recording") {
      const current = recording.current;
      recording.current = null;
      setTrial({ state: "working" });
      const started = performance.now();
      try {
        const text = await current!.stop();
        setTrial({ state: "heard", text, seconds: Math.round((performance.now() - started) / 100) / 10 });
      } catch (cause) { setTrial({ state: "failed", error: cause instanceof Error ? cause.message : "That did not work. Try again." }); }
      return;
    }
    try {
      setTrial({ state: "recording", level: 0 });
      recording.current = await startModelTrial(value, level => setTrial(current => current.state === "recording" ? { state: "recording", level } : current));
    } catch (cause) { setTrial({ state: "failed", error: cause instanceof Error ? cause.message : "Could not start the microphone." }); }
  };

  const status = (id: string) => info?.models.find(model => model.id === id)?.status ?? { state: "missing" as const };
  const ready = selected === CUSTOM ? Boolean(custom) : status(selected).state === "installed";

  return <div hidden={hidden} className="space-y-3">
    <input type="hidden" name="speech_local_model" value={value} />
    {info && !info.supported && <p role="status" className="rounded-lg border border-warning/40 bg-warning-soft p-3 text-sm text-warning">This computer&apos;s processor can&apos;t run local speech models yet, so Moneo uses OpenAI when you have added a key.</p>}
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Model</legend>
      <p className="text-sm text-muted-foreground">Runs on the computer that runs Moneo, also when you talk from your phone. Your recordings never leave it.</p>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {LOCAL_SPEECH_MODELS.map(model => {
          const current = status(model.id);
          return <li key={model.id} className="flex flex-wrap items-center gap-3 p-3">
            <label className="flex min-w-0 flex-1 items-start gap-3 text-sm">
              <input type="radio" className="mt-1 size-4" name="speech_local_model_choice" checked={selected === model.id} onChange={() => choose(model.id)} />
              <span className="min-w-0"><strong className="block font-medium">{model.name}</strong>
                <span className="text-muted-foreground">{megabytes(modelBytes(model))} · {model.languages} · {model.speed}</span></span>
            </label>
            {current.state === "installed" ? <span className="text-sm text-success">Downloaded</span>
              : current.state === "downloading" ? <span className="flex min-w-40 items-center gap-2 text-sm text-muted-foreground" role="status">
                <progress className="h-2 w-24 accent-primary" max={current.total} value={current.received} aria-label={`${model.name} download`} />{Math.floor(current.received / current.total * 100)}%</span>
              : <span className="flex flex-wrap items-center gap-2">
                {current.state === "failed" && <span role="alert" className="text-sm text-danger">{current.error}</span>}
                <button type="button" className={button} disabled={!info?.supported} onClick={() => void download(model.id)}><Download className="size-4" aria-hidden="true" />{current.state === "failed" ? "Retry" : "Download"}</button>
              </span>}
          </li>;
        })}
        <li className="space-y-2 p-3">
          <label className="flex items-start gap-3 text-sm">
            <input type="radio" className="mt-1 size-4" name="speech_local_model_choice" checked={selected === CUSTOM} onChange={() => choose(CUSTOM)} />
            <span><strong className="block font-medium">A model you already have</strong>
              <span className="text-muted-foreground">A folder with a Whisper or Moonshine model in ONNX format (config.json, tokenizer and an onnx folder), for example from Hugging Face.</span></span>
          </label>
          {info?.desktop
            ? <div className="flex flex-wrap items-center gap-2 pl-7">
              <button type="button" className={button} onClick={() => void pickFolder()}><FolderOpen className="size-4" aria-hidden="true" />Choose folder…</button>
              {customPath && <span className="min-w-0 break-all text-sm text-muted-foreground">{customPath}</span>}
            </div>
            : <input className="min-h-10 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm" aria-label="Model folder path" placeholder="/path/to/whisper-small"
              value={customPath} spellCheck={false} autoComplete="off" maxLength={1000}
              onChange={event => { setCustomPath(event.target.value); if (selected !== CUSTOM) setSelected(CUSTOM); onChange(); }}
              onBlur={event => checkFolder(event.target.value)} />}
          {selected === CUSTOM && customPath && custom !== undefined && <p className={`pl-7 text-sm ${custom ? "text-success" : "text-danger"}`} role="status">
            {custom ? `Found a ${custom.family === "moonshine" ? "Moonshine" : "Whisper"} model (${custom.dtype}).` : "No Whisper or Moonshine model in this folder. Use the full path to the folder that holds config.json."}</p>}
        </li>
      </ul>
      {info && <p className="text-xs text-muted-foreground">Downloads are saved in <span className="break-all">{info.folder}</span>. They are not part of backups and stay when you reset your data.</p>}
      {loadError && <p role="alert" className="text-sm text-danger">{loadError}</p>}
    </fieldset>
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" className={button} disabled={!ready || !info?.supported || trial.state === "working"} onClick={() => void tryIt()}>
        {trial.state === "recording" ? <><Square className="size-4" aria-hidden="true" />Stop</> : trial.state === "working" ? <><Loader2 className="size-4 animate-spin" aria-hidden="true" />Transcribing…</> : <><Mic className="size-4" aria-hidden="true" />Try it</>}
      </button>
      {trial.state === "recording" && <span className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <span className="h-2 w-16 overflow-hidden rounded-full bg-muted"><span className="block h-full bg-ai" style={{ width: `${Math.round(trial.level * 100)}%` }} /></span>Say a sentence, then tap Stop.</span>}
      {trial.state === "idle" && <span className="text-sm text-muted-foreground">{ready ? "Say a sentence and see what the model hears." : "Download or choose a model to try it."}</span>}
      {trial.state === "heard" && <p className="min-w-0 text-sm" role="status"><span className="text-muted-foreground">Heard in {trial.seconds} s: </span>{trial.text ? `“${trial.text}”` : "nothing. Try speaking a little louder."}</p>}
      {trial.state === "failed" && <p role="alert" className="text-sm text-danger">{trial.error}</p>}
    </div>
  </div>;
}
