"use client";

import { useEffect, useState } from "react";

type Models = { configured: false } | { configured: true; models: { id: string; name: string }[]; error?: string };
const input = "min-h-10 w-full rounded-lg border border-border bg-card px-3 py-2 text-sm";

export function SpeechOpenRouter({ initial, hidden, onChange }: { initial: string | null; hidden: boolean; onChange: () => void }) {
  const [models, setModels] = useState<Models | null>(null);
  const [loadError, setLoadError] = useState("");
  const [value, setValue] = useState(initial ?? "");
  useEffect(() => {
    if (hidden || models) return;
    fetch("/api/voice/openrouter-models", { cache: "no-store" })
      .then(response => response.ok ? response.json() as Promise<Models> : Promise.reject(new Error("Model list unavailable")))
      .then(setModels, () => setLoadError("The model list is unavailable. Reload the page to try again."));
  }, [hidden, models]);
  const listed = models?.configured ? models.models : [];
  const problem = loadError || (models && !models.configured ? "Add an OpenRouter API key under Keys and connections to use OpenRouter for speech to text." : models?.configured && (models.error || (listed.length === 0 && "OpenRouter lists no models that accept audio right now."))) || "";
  return <div hidden={hidden} className="space-y-2">
    <input type="hidden" name="speech_openrouter_model" value={value} />
    <label className="grid gap-1.5 text-sm font-medium">OpenRouter model
      <select className={input} value={value} disabled={!listed.length && !value} onChange={event => { setValue(event.target.value); onChange(); }}>
        <option value="">{models || loadError ? "Choose a model" : "Loading models…"}</option>
        {value && !listed.some(model => model.id === value) && <option value={value}>{value}</option>}
        {listed.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
      </select>
    </label>
    {problem && <p role="status" className="rounded-lg border border-warning/40 bg-warning-soft p-3 text-sm text-warning">{problem} Until then, Moneo uses OpenAI when you have added a key.</p>}
    {!problem && !value && models && <p className="text-sm text-muted-foreground">Choose a model that accepts audio. Until you do, Moneo uses OpenAI when you have added a key.</p>}
    {!problem && <p className="text-xs text-muted-foreground">Your recording is sent to OpenRouter and the model you choose, billed to your OpenRouter key.</p>}
  </div>;
}
