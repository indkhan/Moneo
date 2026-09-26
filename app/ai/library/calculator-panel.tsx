"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { runIsolatedArtifact } from "@/lib/artifacts/run";

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
  versionLabel,
}: {
  source: string;
  snapshot: unknown;
  initialParams: Record<string, number | string>;
  versionLabel: string;
}) {
  const [params, setParams] = useState(initialParams);
  const [output, setOutput] = useState<CalculatorOutput | null>(null);
  const [status, setStatus] = useState<"idle" | "running" | "done" | "error" | "stopped">("idle");
  const [error, setError] = useState("");
  const runId = useRef(0);
  const stopped = useRef(false);

  const paramEntries = useMemo(() => Object.entries(initialParams), [initialParams]);

  useEffect(() => {
    stopped.current = false;
    const id = ++runId.current;
    const timer = setTimeout(async () => {
      if (stopped.current || runId.current !== id) return;
      setStatus("running");
      setError("");
      try {
        const result = (await runIsolatedArtifact(source, { snapshot, params })) as CalculatorOutput;
        if (stopped.current || runId.current !== id) return;
        setOutput(result && typeof result === "object" ? result : null);
        setStatus("done");
      } catch (err) {
        if (stopped.current || runId.current !== id) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      }
    }, 300); // debounce rapidly changing inputs (§37)
    return () => clearTimeout(timer);
  }, [source, snapshot, params]);

  function stop() {
    stopped.current = true;
    runId.current += 1;
    setStatus("stopped");
  }

  return (
    <section aria-label="Generated calculator output" className="mt-8 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">Generated calculator · {versionLabel}</h2>
        <div className="flex gap-2 text-sm">
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
        </div>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Isolated QuickJS/Web Worker output (illustrative). Authoritative balances, forecasts, and
        goals appear in the trusted sections above.
      </p>

      {paramEntries.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-3">
          {paramEntries.map(([name]) => (
            <label key={name} className="text-sm">
              {name}
              <input
                value={String(params[name] ?? "")}
                onChange={(e) => {
                  const raw = e.target.value;
                  const num = Number(raw);
                  setParams((p) => ({ ...p, [name]: raw !== "" && Number.isFinite(num) ? num : raw }));
                }}
                inputMode="decimal"
                className="mt-1 block w-40 rounded border p-2"
              />
            </label>
          ))}
        </div>
      )}

      <p role="status" className="mt-3 text-sm text-muted-foreground">
        {status === "running" && "Running in QuickJS/Web Worker…"}
        {status === "stopped" && "Stopped. Re-run to execute again."}
        {status === "error" && `Calculator failed: ${error}`}
      </p>

      {status === "done" && output && (
        <div className="mt-3 text-sm">
          {output.unavailable && <p>{output.unavailable}</p>}
          {output.warning && <p className="text-muted-foreground">Note: {output.warning}</p>}
          {output.summary && <p className="font-medium">{output.summary}</p>}
          {output.numbers && (
            <dl className="mt-3 grid gap-2 sm:grid-cols-2">
              {Object.entries(output.numbers).map(([k, v]) => (
                <div key={k} className="rounded border p-2">
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
            <ul className="mt-3 divide-y rounded border">
              {output.rows.slice(0, 20).map((row, i) => (
                <li key={String(row.id ?? i)} className="p-2 font-mono text-xs">
                  {row.name ? `${row.name} · ` : ""}
                  {JSON.stringify(row)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
