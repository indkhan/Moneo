"use client";

import Link from "next/link";
import { Check, HousePlus, LayoutDashboard, RefreshCw } from "lucide-react";
import { ArtifactThumbnail } from "@/components/artifact-frame";
import { SafeForm } from "@/components/safe-form";
import type { ToolStep } from "@/components/ai-tool-activity";
import { publishCardSafely } from "@/app/dashboard-actions";
import { PendingSubmit } from "./artifact-controls";

export type HomeVersions = Record<string, number | null>;
type Saved = { kind: "page"; version: number } | { kind: "card"; cardId: string; version: number; title: string };

const field = (output: string, name: string, pattern: string) => output.match(new RegExp(String.raw`"${name}":\s*${pattern}`))?.[1];

export function savedVersion(step: ToolStep): Saved | null {
  if (step.state !== "done" || !step.output || !field(step.output, "saved", "(true)")) return null;
  if (step.name === "write_page") {
    const version = Number(field(step.output, "pageVersion", "(\\d+)"));
    return version ? { kind: "page", version } : null;
  }
  if (step.name !== "write_card" && step.name !== "card_preset") return null;
  const cardId = field(step.output, "cardId", '"([0-9a-f-]{36})"');
  const version = Number(field(step.output, "version", "(\\d+)"));
  const title = (step.input as { title?: unknown } | undefined)?.title;
  return cardId && version ? { kind: "card", cardId, version, title: typeof title === "string" ? title : "Home card" } : null;
}

const item = "mt-2 flex items-center gap-3 rounded-xl border border-border bg-card p-2 text-xs";
const action = "inline-flex min-h-8 items-center gap-1 rounded-lg px-2.5 font-medium";

export function SavedVersion({ step, artifactId, home }: { step: ToolStep; artifactId: string; home: HomeVersions }) {
  const saved = savedVersion(step);
  if (!saved) return null;
  if (saved.kind === "page") return <div className={item}>
    <span className="w-24 shrink-0 overflow-hidden rounded-md border border-border"><ArtifactThumbnail src={`/ai/artifacts/${artifactId}/frame?v=${saved.version}`} title={`Page version ${saved.version}`} /></span>
    <span className="min-w-0 flex-1"><span className="block font-medium text-foreground">Page v{saved.version}</span></span>
    <Link href={`/ai/artifacts/${artifactId}?tab=page&v=${saved.version}`} className={`${action} border border-border hover:bg-muted`}>Open</Link>
  </div>;
  const shown = home[saved.cardId];
  const onHome = shown !== undefined && shown !== null;
  return <div className={item}>
    <span className="grid size-10 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"><LayoutDashboard className="size-4" aria-hidden="true" /></span>
    <span className="min-w-0 flex-1"><span className="block truncate font-medium text-foreground">{saved.title}</span><span className="text-muted-foreground">Home card v{saved.version}</span></span>
    <Link href={`/ai/artifacts/${artifactId}?tab=cards&card=${saved.cardId}&cv=${saved.version}`} className={`${action} border border-border hover:bg-muted`}>Open</Link>
    {shown === saved.version ? <span className={`${action} text-brand`}><Check className="size-3.5" aria-hidden="true" />On Home</span>
      : <SafeForm action={publishCardSafely}><input type="hidden" name="id" value={saved.cardId} /><input type="hidden" name="version" value={saved.version} /><input type="hidden" name="shown" value={shown ?? ""} />
        <PendingSubmit className={`${action} bg-primary text-primary-foreground hover:opacity-90`}>{onHome ? <><RefreshCw className="size-3.5" aria-hidden="true" />Update on Home</> : <><HousePlus className="size-3.5" aria-hidden="true" />Add to Home</>}</PendingSubmit></SafeForm>}
  </div>;
}
