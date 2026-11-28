"use client";

import { useAiAccess } from "@/lib/ai/use-ai-access";

export function ModelPicker({ agent, value, onChange, problem = "", name, title }: { agent: "chat" | "artifacts"; value: string; onChange: (model: string) => void; problem?: string; name?: string; title: string }) {
  const access = useAiAccess();
  if (!access?.models.length && !value) return null;
  const fallback = agent === "artifacts" ? access?.artifactModel : access?.chatModel;
  const options = [...new Set([...access?.models ?? [], ...value ? [value] : []])];
  return <label className="flex min-w-0 items-center" title={problem || title}>
    <span className="sr-only">{agent === "artifacts" ? "Model for this artifact" : "Model for this chat"}</span>
    <select name={name} value={value} onChange={event => onChange(event.target.value)} aria-invalid={!!problem || undefined}
      className={`h-8 max-w-40 min-w-0 truncate rounded-lg bg-transparent px-1.5 text-xs hover:bg-muted hover:text-foreground focus:outline-none sm:max-w-56 ${problem ? "text-danger" : "text-muted-foreground"}`}>
      <option value="">{fallback ? `Default · ${fallback}` : "Default model"}</option>
      {options.map(option => <option key={option} value={option}>{option}</option>)}
    </select>
    {problem && <span role="alert" className="sr-only">{problem}</span>}
  </label>;
}
