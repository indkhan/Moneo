"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { assertTripCostCurrency } from "@/lib/artifacts/trip-params";
import { runIsolatedArtifact } from "@/lib/artifacts/run";
import { checkOutputShape } from "@/lib/artifacts/output";
import { saveCalculatorParams } from "./actions";
import { calculatorExportText, downloadCalculatorPng, printCalculator } from "@/lib/artifacts/export";
import { coverageWarnings } from "@/lib/artifacts/coverage";
import { calculatorManifestSchema, normalizeCalculatorParams, isMinorParam, type CalculatorManifest } from "@/lib/artifacts/spec";
import { formatMoney } from "@/lib/finance/format";
import { ForecastEvidence, type ForecastEvidenceInput } from "./forecast-evidence";
import { CalculatorOutputView, type CalculatorOutput } from "./calculator-output";
import { useStateDraft, StateDraftRecovery } from "./use-state-draft";
import { refreshTripSnapshot } from "@/lib/artifacts/trip-preview";

export function CalculatorPanel({
  source,
  snapshot,
  initialParams,
  stateVersion = 0,
  versionLabel,
  artifactId,
  title = "Financial calculator",
  locale,
  manifest,
  inputWarnings = [],
  currency,
}: {
  source: string;
  snapshot: unknown;
  initialParams: Record<string, number | string>;
  stateVersion?: number;
  versionLabel: string;
  artifactId: string;
  title?: string;
  locale?: string;
  manifest: CalculatorManifest;
  inputWarnings?: string[];
  currency?: string;
}) {
  const draft = useStateDraft(initialParams, stateVersion, saveCalculatorParams);
  const params = draft.value, setParams = draft.edit;
  const dependencies = useMemo(() => ({ source, snapshot, params, manifest, versionLabel, artifactId }), [source, snapshot, params, manifest, versionLabel, artifactId]);
  const [completed, setCompleted] = useState<{ dependencies: typeof dependencies; output: CalculatorOutput; params: Record<string, string | number>; snapshot: unknown; versionLabel: string; completedAt: string; evidenceRevision: string } | null>(null);
  const output = completed?.dependencies === dependencies ? completed.output : null;
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error" | "stopped">("idle");
  const exportable = status === "done" && completed?.dependencies === dependencies;
  const [error, setError] = useState("");
  const runId = useRef(0);
  const stopped = useRef(false);
  const activeRun = useRef<AbortController | null>(null);
  const monthChanged = typeof params.month === "string" && params.month !== initialParams.month;
  const tripChanged = manifest.sdk.includes("forecast") && ["costMinor", "tripDate", "accountId"].some(key => params[key] !== initialParams[key]);
  const shownSnapshot = completed?.dependencies === dependencies ? completed.snapshot : snapshot;

  const paramEntries = useMemo(() => Object.entries(manifest.params), [manifest.params]);

  const inputError = useMemo(() => {
    try {
      const parsed = calculatorManifestSchema.parse(manifest);
      const forecastCurrency = currency ?? (snapshot !== null && typeof snapshot === "object" && "currency" in snapshot && typeof snapshot.currency === "string" ? snapshot.currency : undefined);
      if (parsed.sdk.includes("forecast") && forecastCurrency) assertTripCostCurrency(parsed.params.costMinor?.currency, forecastCurrency);
      normalizeCalculatorParams(parsed, params); return "";
    }
    catch (failure) { return failure instanceof Error ? failure.message : "Invalid inputs"; }
  }, [manifest, params, currency, snapshot]);

  useEffect(() => {
    stopped.current = false;
    const id = ++runId.current;
    const controller = new AbortController();
    activeRun.current = controller;
    const timer = setTimeout(async () => {
      if (stopped.current || runId.current !== id) return;
      setStatus("running");
      setError("");
      try {
        if (inputError) throw new Error(inputError);
        if (monthChanged) {
          setCompleted(null);
          setStatus("done");
          return;
        }
        const runParams = normalizeCalculatorParams(calculatorManifestSchema.parse(manifest), params);
        const runSnapshot = structuredClone(tripChanged ? await refreshTripSnapshot(snapshot, runParams, artifactId, controller.signal) : snapshot);
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(runSnapshot)));
        const evidenceRevision = `sha256:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
        if (stopped.current || runId.current !== id) return;
        const result = (await runIsolatedArtifact(source, { snapshot: runSnapshot, params: runParams }, controller.signal, manifest)) as CalculatorOutput;
        if (stopped.current || runId.current !== id) return;
        const outputErrors = checkOutputShape(result);
        if (outputErrors.length) throw new Error(outputErrors.join("; "));
        setCompleted(result && typeof result === "object" ? { dependencies, output: result, params: runParams, snapshot: runSnapshot, versionLabel, completedAt: new Date().toISOString(), evidenceRevision } : null);
        setStatus("done");
      } catch (err) {
        if (stopped.current || runId.current !== id) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      if (runId.current === id) runId.current += 1;
      controller.abort();
      if (activeRun.current === controller) activeRun.current = null;
    };
  }, [dependencies, source, snapshot, params, monthChanged, tripChanged, manifest, inputError, versionLabel, artifactId]);

  function stop() {
    stopped.current = true;
    runId.current += 1;
    activeRun.current?.abort();
    setStatus("stopped");
  }

  function exportResult(format: "print" | "png") {
    if (!exportable || !completed) return;
    try {
      const text = calculatorExportText(title, completed.versionLabel, completed.output, completed.params, completed.snapshot, locale, { artifactId: completed.dependencies.artifactId, completedAt: completed.completedAt, evidenceRevision: completed.evidenceRevision });
      if (format === "print") printCalculator(text); else downloadCalculatorPng(text);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Export unavailable"); }
  }

  const tool = "rounded-md border border-border bg-background px-2.5 py-1 font-medium hover:bg-muted disabled:opacity-50";
  return (
    <section aria-label="Generated calculator output" className="rounded-xl border border-border bg-card p-5 shadow-sm">
      {snapshot !== null && typeof snapshot === "object" && "partial" in snapshot && snapshot.partial === true && <p role="status" className="mb-4 text-sm text-amber-700">Partial financial data: transactions awaiting classification are excluded. Review them in Import before relying on these totals.</p>}
      {shownSnapshot !== null && typeof shownSnapshot === "object" && "unavailable" in shownSnapshot && typeof shownSnapshot.unavailable === "string" && shownSnapshot.unavailable && <p role="alert" className="mb-4 text-sm text-muted-foreground">{shownSnapshot.unavailable}</p>}
      {tripChanged && status !== "error" && status !== "stopped" && completed?.dependencies !== dependencies && <p role="status" className="mb-4 text-sm">Recalculating the local dated trip inputs. Saved forecast evidence appears below until this preview completes.</p>}
      <ForecastEvidence evidence={shownSnapshot !== null && typeof shownSnapshot === "object" && "forecast" in shownSnapshot ? (shownSnapshot.forecast ?? {}) as ForecastEvidenceInput : (shownSnapshot ?? {}) as ForecastEvidenceInput} locale={locale} />
      {coverageWarnings(shownSnapshot).map(warning => <p key={warning} role="status" className="mb-4 text-sm text-amber-700">{warning}</p>)}
      {inputWarnings.map(warning => <p key={warning} role="status" className="mb-4 text-sm text-amber-700">{warning}</p>)}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span aria-hidden className={`size-2 rounded-full ${status === "error" ? "bg-destructive" : status === "running" ? "animate-pulse bg-brand" : exportable ? "bg-emerald-500" : "bg-muted-foreground/40"}`} />
          <h2 className="text-base font-semibold tracking-tight">Result · {versionLabel}</h2>
        </div>
        <div className="flex flex-wrap gap-1.5 text-xs">
          <button type="button" onClick={stop} className={tool}>Stop</button>
          <button type="button" onClick={() => { stopped.current = false; setParams({ ...params }); }} className={tool}>Re-run</button>
          <button type="button" disabled={!exportable} onClick={() => exportResult("print")} className={tool}>Print / PDF</button>
          <button type="button" disabled={!exportable} onClick={() => exportResult("png")} className={tool}>Export PNG</button>
        </div>
      </div>

      <div className={`mt-4 grid gap-6 ${paramEntries.length ? "lg:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]" : ""}`}>
        {paramEntries.length > 0 && (
          <form action={draft.action} className="space-y-3" aria-label="Calculator inputs">
            <input type="hidden" name="artifactId" value={artifactId} />
            <input type="hidden" name="params" value={JSON.stringify(params)} />
            <input type="hidden" name="expectedVersion" value={draft.expectedVersion} />
            {paramEntries.map(([name, def]) => (
              <label key={name} className="block text-sm font-medium">
                {def.label ?? name}{isMinorParam(name, def) ? ` (minor units, ${def.currency ?? currency ?? "currency unavailable"})` : def.unit ? ` (${def.unit})` : ""}
                <input
                  value={String(params[name] ?? "")}
                  disabled={draft.busy}
                  onChange={(e) => {
                    const raw = e.target.value;
                    setParams((p) => ({ ...p, [name]: def.type === "number" && raw.trim() !== "" ? Number(raw) : raw }));
                  }}
                  type={def.type === "number" ? "number" : "text"}
                  min={def.type === "number" ? def.min : undefined}
                  max={def.type === "number" ? def.max : undefined}
                  step={isMinorParam(name, def) ? "1" : "any"}
                  maxLength={def.type === "string" ? def.maxLength ?? 200 : undefined}
                  inputMode={isMinorParam(name, def) ? "numeric" : def.type === "number" ? "decimal" : "text"}
                  aria-invalid={Boolean(inputError)}
                  className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 font-normal tabular-nums"
                />
                {isMinorParam(name, def) && (def.currency ?? currency) && <span className="mt-1 block text-xs font-normal text-muted-foreground">100 minor units = {formatMoney(100n, (def.currency ?? currency)!, locale)}. Stored as exact minor units.</span>}
              </label>
            ))}
            <button type="submit" disabled={Boolean(inputError) || draft.busy || draft.conflict} className="w-full rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">Save inputs</button>
          </form>
        )}
        <div className="min-w-0">
          <p role="status" className={`text-sm ${status === "error" ? "rounded-lg border border-destructive/40 bg-destructive/5 px-3 py-2 text-destructive" : "text-muted-foreground"}`}>
            {monthChanged && "Save inputs to load financial evidence for the selected month."}
            {status === "done" && !exportable && !monthChanged && "Inputs or evidence changed. Recalculating?"}
            {status === "running" && "Running in QuickJS/Web Worker…"}
            {status === "stopped" && "Stopped. Re-run to execute again."}
            {status === "error" && `Calculator failed: ${error}`}
          </p>
          {error && status !== "error" && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
          {exportable && output && (
            <div className="mt-2">
              <CalculatorOutputView output={output} locale={locale} currency={snapshot !== null && typeof snapshot === "object" && "currency" in snapshot && typeof snapshot.currency === "string" && snapshot.currency ? snapshot.currency : currency} />
            </div>
          )}
        </div>
      </div>
      <StateDraftRecovery {...draft} />
      <p className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">
        Illustrative results from dated financial evidence. Validation checks execution and output shape; it does not verify financial claims. Exports include inputs and evidence so unknown or partial data stays visible.
      </p>
    </section>
  );
}
