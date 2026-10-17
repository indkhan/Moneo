"use client";

import { useEffect, useMemo, useState } from "react";
import { runIsolatedArtifact } from "@/lib/artifacts/run";
import { checkOutputShape } from "@/lib/artifacts/output";
import { calculatorManifestSchema, checkSourceAllowlist, normalizeCalculatorParams, type CalculatorManifest } from "@/lib/artifacts/spec";
import { CalculatorOutputView, type CalculatorOutput } from "./calculator-output";

// Fast client-side copy of the server's static checks. The server still
// re-validates every save; this only gives immediate, itemised feedback.
export function draftProblems(source: string, manifest: unknown): { manifest?: CalculatorManifest; errors: string[] } {
  const errors = checkSourceAllowlist(source).map(message => `Source: ${message}`);
  const parsed = calculatorManifestSchema.safeParse(manifest);
  if (!parsed.success) errors.push(...parsed.error.issues.map(issue => `Manifest ${issue.path.join(".") || "root"}: ${issue.message}`));
  return { manifest: parsed.success ? parsed.data : undefined, errors };
}

function ProblemList({ errors, label }: { errors: string[]; label: string }) {
  if (!errors.length) return null;
  return <div aria-live="polite" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
    <p className="font-medium">{label}</p>
    <ul className="mt-1 list-disc space-y-0.5 pl-5">{errors.map(error => <li key={error} className="break-words">{error}</li>)}</ul>
  </div>;
}

type Run = { key: string; output?: CalculatorOutput; error?: string };

// Runs an unsaved draft in the same QuickJS Web Worker (same memory, stack and
// time limits) against the evidence already loaded for this page.
export function DraftPreview({ source, manifestText, snapshot, params, currency, locale }: {
  source: string;
  manifestText: string;
  snapshot: unknown;
  params: Record<string, number | string>;
  currency?: string;
  locale?: string;
}) {
  const key = useMemo(() => JSON.stringify([source, manifestText, params]), [source, manifestText, params]);
  const checked = useMemo(() => {
    let manifest: unknown;
    try { manifest = JSON.parse(manifestText); } catch { return { errors: ["Manifest is not valid JSON"] } as ReturnType<typeof draftProblems>; }
    return draftProblems(source, manifest);
  }, [source, manifestText]);
  const [run, setRun] = useState<Run | null>(null);
  const current = run?.key === key ? run : null;
  const blocked = checked.errors.length > 0;

  useEffect(() => {
    if (blocked || !checked.manifest) return;
    const valid = checked.manifest;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const runParams = normalizeCalculatorParams(valid, params, "restore");
        const output = await runIsolatedArtifact(source, { snapshot: structuredClone(snapshot ?? null), params: runParams }, controller.signal, valid);
        const errors = checkOutputShape(output);
        if (!controller.signal.aborted) setRun(errors.length ? { key, error: errors.join("; ") } : { key, output: output as CalculatorOutput });
      } catch (error) {
        if (!controller.signal.aborted) setRun({ key, error: error instanceof Error ? error.message : String(error) });
      }
    }, 400);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [key, blocked, checked.manifest, source, snapshot, params]);

  const state = blocked ? "Fix errors" : !current ? "Running…" : current.error ? "Failed" : "Live";
  return <div aria-label="Draft preview" role="region" className="min-w-0 space-y-3">
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-sm font-semibold">Live preview</h3>
      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${state === "Live" ? "bg-emerald-500/10 text-emerald-700" : state === "Running…" ? "bg-muted text-muted-foreground" : "bg-destructive/10 text-destructive"}`}>{state}</span>
    </div>
    <ProblemList label="Static checks failed" errors={checked.errors} />
    {current?.error && <ProblemList label="Sandbox run failed" errors={[current.error]} />}
    {current?.output && <CalculatorOutputView output={current.output} currency={currency} locale={locale} />}
    <p className="text-xs text-muted-foreground">Runs your unsaved draft in the QuickJS sandbox against the evidence loaded for the active version, with saved or default inputs. Saving re-validates on the server.</p>
  </div>;
}
