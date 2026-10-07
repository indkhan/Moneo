"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { runIsolatedArtifact } from "@/lib/artifacts/run";
import { checkOutputShape } from "@/lib/artifacts/output";
import { saveCalculatorParams } from "./actions";
import { calculatorExportText, downloadCalculatorPng, printCalculator } from "@/lib/artifacts/export";
import { coverageWarnings } from "@/lib/artifacts/coverage";
import { calculatorManifestSchema, normalizeCalculatorParams, isMinorParam, type CalculatorManifest } from "@/lib/artifacts/spec";
import { formatMoney } from "@/lib/finance/format";
import { ForecastEvidence, type ForecastEvidenceInput } from "./forecast-evidence";
import { CalculatorRows } from "./calculator-rows";
import { useStateDraft, StateDraftRecovery } from "./use-state-draft";
import { refreshTripSnapshot } from "@/lib/artifacts/trip-preview";

const Chart = dynamic(() => import("echarts-for-react"), { ssr: false });

type CalculatorOutput = {
  summary?: string;
  rows?: { id?: string; name?: string; [k: string]: unknown }[];
  numbers?: Record<string, string | number>;
  chart?: { labels?: string[]; values?: number[] };
  unavailable?: string;
  warning?: string;
};

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
    try { normalizeCalculatorParams(calculatorManifestSchema.parse(manifest), params); return ""; }
    catch (failure) { return failure instanceof Error ? failure.message : "Invalid inputs"; }
  }, [manifest, params]);

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

  return (
    <section aria-label="Generated calculator output" className="mt-8 rounded-xl border border-border bg-card p-5 shadow-sm">
      {snapshot !== null && typeof snapshot === "object" && "partial" in snapshot && snapshot.partial === true && <p role="status" className="mb-4 text-sm text-amber-700">Partial financial data: transactions awaiting classification are excluded. Review them in Import before relying on these totals.</p>}
      {snapshot !== null && typeof snapshot === "object" && "unavailable" in snapshot && typeof snapshot.unavailable === "string" && snapshot.unavailable && <p role="alert" className="mb-4 text-sm text-muted-foreground">{snapshot.unavailable}</p>}
      {tripChanged && completed?.dependencies !== dependencies && <p role="status" className="mb-4 text-sm">Recalculating the local dated trip inputs. Saved forecast evidence appears below until this preview completes.</p>}
      <ForecastEvidence evidence={shownSnapshot !== null && typeof shownSnapshot === "object" && "forecast" in shownSnapshot ? (shownSnapshot.forecast ?? {}) as ForecastEvidenceInput : (shownSnapshot ?? {}) as ForecastEvidenceInput} locale={locale} />
      {coverageWarnings(shownSnapshot).map(warning => <p key={warning} role="status" className="mb-4 text-sm text-amber-700">{warning}</p>)}
      {inputWarnings.map(warning => <p key={warning} role="status" className="mb-4 text-sm text-amber-700">{warning}</p>)}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Generated calculator · {versionLabel}</h2>
        <div className="flex gap-2 text-sm">
          <button type="button" disabled={!exportable} onClick={() => exportResult("print")} className="rounded border px-3 py-1 disabled:opacity-50">Print / PDF</button>
          <button type="button" disabled={!exportable} onClick={() => exportResult("png")} className="rounded border px-3 py-1 disabled:opacity-50">Export PNG</button>
          <button type="button" onClick={stop} className="rounded border px-3 py-1">
            Stop
          </button>
          <button
            type="button"
            onClick={() => {
              stopped.current = false;
              setParams({ ...params });
            }}
            className="rounded border px-3 py-1"
          >
            Re-run
          </button>
          <form action={draft.action} className="inline">
            <input type="hidden" name="artifactId" value={artifactId} />
            <input type="hidden" name="params" value={JSON.stringify(params)} />
            <input type="hidden" name="expectedVersion" value={draft.expectedVersion} />
            <button type="submit" disabled={Boolean(inputError) || draft.busy || draft.conflict} className="rounded border px-3 py-1 disabled:opacity-50">
              Save inputs
            </button>
          </form>
        </div>
      </div>
      <StateDraftRecovery {...draft} />
      <p className="mt-1 text-xs text-muted-foreground">
        Illustrative results from dated financial evidence. Validation checks execution and output shape; it does not verify financial claims. Exports include inputs and evidence so unknown or partial data stays visible.
      </p>

      {paramEntries.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-3">
          {paramEntries.map(([name, def]) => (
            <label key={name} className="text-sm">
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
                className="mt-1 block w-40 rounded-lg border border-border bg-card px-3 py-2"
              />
              {isMinorParam(name, def) && (def.currency ?? currency) && <span className="mt-1 block text-xs text-muted-foreground">100 minor units = {formatMoney(100n, (def.currency ?? currency)!, locale)}. Stored as exact minor units.</span>}
            </label>
          ))}
        </div>
      )}

      <p role="status" className="mt-3 text-sm text-muted-foreground">
        {monthChanged && "Save inputs to load financial evidence for the selected month."}
        {status === "done" && !exportable && !monthChanged && "Inputs or evidence changed. Recalculating?"}
        {status === "running" && "Running in QuickJS/Web Worker…"}
        {status === "stopped" && "Stopped. Re-run to execute again."}
        {status === "error" && `Calculator failed: ${error}`}
      </p>
      {error && status !== "error" && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}

      {exportable && output && (
        <div className="mt-3 text-sm">
          {output.unavailable && <p>{output.unavailable}</p>}
          {output.warning && <p className="text-muted-foreground">Note: {output.warning}</p>}
          {output.summary && <p className="font-medium">{output.summary}</p>}
          {output.numbers && (
            <dl className="mt-3 grid gap-2 sm:grid-cols-2">
              {Object.entries(output.numbers).map(([k, v]) => (
                <div key={k} className="rounded-lg border border-border bg-card px-3 py-2">
                  <dt className="text-xs text-muted-foreground">{k}</dt>
                  <dd className="font-mono">{String(v)}</dd>
                </div>
              ))}
            </dl>
          )}
          {output.chart?.labels && output.chart?.values && (
            <div className="mt-4" role="img" aria-label="Generated calculator chart">
              <Chart
                style={{ height: 220 }}
                option={{
                  tooltip: { trigger: "axis" },
                  xAxis: { type: "category", data: output.chart.labels },
                  yAxis: { type: "value" },
                  series: [{ type: "bar", data: output.chart.values }],
                }}
              />
            </div>
          )}
          {output.rows && output.rows.length > 0 && (
            <CalculatorRows rows={output.rows} locale={locale} currency={snapshot !== null && typeof snapshot === "object" && "currency" in snapshot && typeof snapshot.currency === "string" ? snapshot.currency : undefined} />
          )}
        </div>
      )}
    </section>
  );
}
