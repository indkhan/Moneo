"use client";
import { useEffect, useState } from "react";
import { tripScenarioSchema, type TripScenario, type TripScenarioResult } from "@/lib/finance/trip-scenario";
import { saveDatedTripState } from "./actions";
import { useStateDraft, StateDraftRecovery } from "./use-state-draft";
import { formatMoney } from "@/lib/finance/format";
import { ForecastEvidence } from "./forecast-evidence";
import { SourceCoverageDetails } from "@/app/source-coverage";
import type { SourceCoverage } from "@/lib/finance/source-coverage";

export function DatedTripForm({ artifactId, stateVersion, initial, initialResult, accounts, sourceCoverage }: {
  artifactId: string; stateVersion: number; initial: TripScenario; initialResult: TripScenarioResult;
  accounts: { id: string; currencyCode: string; name?: string }[]; sourceCoverage?: SourceCoverage;
}) {
  const draft = useStateDraft(initial, stateVersion, saveDatedTripState);
  const scenario = draft.value;
  const [preview, setPreview] = useState<{ inputs: TripScenario; result: TripScenarioResult; coverage?: SourceCoverage } | null>(null);
  const [failure, setFailure] = useState<{ inputs: TripScenario; message: string } | null>(null);
  const [pendingInputs, setPendingInputs] = useState<TripScenario | null>(null);
  const error = failure?.inputs === scenario ? failure.message : "";
  const pending = pendingInputs === scenario;
  const parsed = tripScenarioSchema.safeParse(scenario);
  const active = preview?.inputs === scenario ? preview : scenario === initial ? { result: initialResult, coverage: sourceCoverage } : null;
  useEffect(() => {
    if (scenario === initial) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setPendingInputs(scenario); setFailure(null);
      try {
        const valid = tripScenarioSchema.parse(scenario);
        const response = await fetch("/api/artifacts/trip", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ artifactId, scenario: valid }), signal: controller.signal });
        const data = await response.json();
        if (!response.ok || !data.tripResult) throw new Error(data.error ?? "Trip preview unavailable");
        if (!controller.signal.aborted) setPreview({ inputs: scenario, result: data.tripResult, coverage: data.sourceCoverage });
      } catch (failure) {
        if (!controller.signal.aborted) setFailure({ inputs: scenario, message: failure instanceof Error ? failure.message : "Trip preview unavailable" });
      } finally { if (!controller.signal.aborted) setPendingInputs(null); }
    }, 300);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [artifactId, initial, scenario]);
  function editPayment(index: number, patch: Partial<TripScenario["payments"][number]>) {
    draft.edit({ ...scenario, payments: scenario.payments.map((item, i) => i === index ? { ...item, ...patch } : item) });
  }
  const cls = "mt-1 block w-full rounded border border-border bg-card px-3 py-2";
  const money = (value: string | null) => value === null ? "Unavailable" : formatMoney(value, initialResult.currency);
  return <>
    <form action={draft.action} className="mt-4 space-y-4" aria-label="Dated trip scenario">
      <input type="hidden" name="artifactId" value={artifactId} /><input type="hidden" name="expectedVersion" value={draft.expectedVersion} />
      <input type="hidden" name="scenario" value={JSON.stringify(scenario)} />
      <fieldset disabled={draft.busy} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-4">
          <label className="text-sm">Destination<input value={scenario.destination} maxLength={120} onChange={event => draft.edit({ ...scenario, destination: event.target.value })} className={cls} /></label>
          <label className="text-sm">Trip start<input type="date" value={scenario.startsOn} onChange={event => draft.edit({ ...scenario, startsOn: event.target.value })} className={cls} /></label>
          <label className="text-sm">Trip end<input type="date" value={scenario.endsOn} onChange={event => draft.edit({ ...scenario, endsOn: event.target.value })} className={cls} /></label>
          <label className="text-sm">Days after final trip payment<input type="number" min="0" max="90" value={scenario.postTripDays} onChange={event => draft.edit({ ...scenario, postTripDays: Number(event.target.value) })} className={cls} /></label>
        </div>
        <p className="text-sm text-muted-foreground">Every obligation from the current dated balance through the trip and post-trip period is included. Budget amounts are exact minor units in each listed currency.</p>
        {scenario.payments.map((item, index) => <fieldset key={index} className="rounded border p-3"><legend className="px-1 text-sm">Payment {index + 1}</legend>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="text-sm">Name<input value={item.name} maxLength={120} onChange={event => editPayment(index, { name: event.target.value })} className={cls} /></label>
            <label className="text-sm">Type<select value={item.kind} onChange={event => editPayment(index, { kind: event.target.value as "cost" | "contribution" })} className={cls}><option value="cost">Trip cost</option><option value="contribution">External contribution</option></select></label>
            <label className="text-sm">Payment date<input type="date" value={item.date} onChange={event => editPayment(index, { date: event.target.value })} className={cls} /></label>
            <label className="text-sm">Amount in minor units<input inputMode="numeric" value={item.amountMinor} maxLength={18} onChange={event => editPayment(index, { amountMinor: event.target.value })} className={cls} /><span className="text-xs">100 minor units = {(() => { try { return formatMoney(100n, item.currencyCode); } catch { return "Choose a currency"; } })()}</span></label>
            <label className="text-sm">Currency<input value={item.currencyCode} maxLength={3} onChange={event => editPayment(index, { currencyCode: event.target.value.toUpperCase() })} className={cls} /></label>
            <label className="text-sm">Paying / receiving account<select value={item.accountId} onChange={event => editPayment(index, { accountId: event.target.value })} className={cls}><option value="unselected">Choose an account</option>{accounts.map(account => <option key={account.id} value={account.id}>{account.name ?? account.id}</option>)}</select></label>
          </div>
          {item.currencyCode !== initialResult.currency && <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <p className="col-span-full text-sm">Explicit hypothetical conversion: 1 {item.currencyCode} buys this many {initialResult.currency}. A future rate is an assumption.</p>
            <label className="text-sm">Rate<input value={item.fx?.rate ?? ""} onChange={event => editPayment(index, { fx: { rate: event.target.value, date: item.fx?.date ?? item.date, source: item.fx?.source ?? "User trip assumption" } })} className={cls} /></label>
            <label className="text-sm">Rate date<input type="date" value={item.fx?.date ?? item.date} onChange={event => editPayment(index, { fx: { rate: item.fx?.rate ?? "", date: event.target.value, source: item.fx?.source ?? "User trip assumption" } })} className={cls} /></label>
            <label className="text-sm">Rate source<input value={item.fx?.source ?? "User trip assumption"} maxLength={120} onChange={event => editPayment(index, { fx: { rate: item.fx?.rate ?? "", date: item.fx?.date ?? item.date, source: event.target.value } })} className={cls} /></label>
          </div>}
          <button type="button" disabled={scenario.payments.length === 1} onClick={() => draft.edit({ ...scenario, payments: scenario.payments.filter((_, i) => i !== index) })} className="mt-3 rounded border px-3 py-1 text-sm disabled:opacity-50">Remove payment</button>
        </fieldset>)}
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={scenario.payments.length >= 50} onClick={() => draft.edit({ ...scenario, payments: [...scenario.payments, { name: "Trip cost", kind: "cost", date: scenario.startsOn, accountId: accounts[0]?.id ?? "unselected", amountMinor: "0", currencyCode: initialResult.currency }] })} className="rounded border px-3 py-2">Add payment</button>
          <button type="button" onClick={draft.reload} className="rounded border px-3 py-2">Undo local changes</button>
          <button disabled={!parsed.success || draft.conflict} className="rounded border px-3 py-2 disabled:opacity-50">Save scenario</button>
        </div>
      </fieldset>
    </form>
    <StateDraftRecovery {...draft} />
    {!parsed.success && <p role="alert" className="mt-3 text-sm">Check dates, integer minor amounts, accounts and currency/rate fields before calculating.</p>}
    {error && <p role="alert" className="mt-3 text-sm">{error}</p>}
    {!active && <p role="status" className="mt-4 text-sm">{pending ? "Recalculating dated scenario…" : "Local changes awaiting dated preview."}</p>}
    {active && <div aria-label="Dated trip results" className="mt-5 space-y-3">
      <p className="text-sm">Forecast horizon: {active.result.horizon.from} to {active.result.horizon.to} ({active.result.horizon.days} days). Trip: {active.result.scenario.startsOn} to {active.result.scenario.endsOn}.</p>
      <p className="text-sm">Budget costs {money(active.result.costMinor)} · external contributions {money(active.result.contributionMinor)} · net cost {money(active.result.netCostMinor)}.</p>
      {active.result.unavailable && <p role="status">{active.result.unavailable}</p>}
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded border p-3"><h3>Baseline minimum headroom</h3><p>{money(active.result.baselineAvailableMinor)}</p><p className="text-xs">Limited on {active.result.baselineLimitingDate ?? "unknown"}</p></div>
        <div className="rounded border p-3"><h3>With-trip minimum headroom</h3><p>{money(active.result.withTripAvailableMinor)}</p><p className="text-xs">Limited on {active.result.limitingDate ?? "unknown"}</p></div>
        <div className="rounded border p-3"><h3>End-of-trip headroom</h3><p>{money(active.result.afterTripMinor)}</p><p className="text-xs">On {active.result.afterTripDate}; single paying account only</p></div>
      </div>
      <ul className="list-disc pl-5 text-sm text-muted-foreground">{active.result.assumptions.map(item => <li key={item}>{item}</li>)}</ul>
      {active.coverage && <SourceCoverageDetails coverage={active.coverage} />}
      <h3 className="font-semibold">Baseline account evidence</h3><ForecastEvidence evidence={{ accountId: active.result.accountId, liquidity: active.result.liquidity }} />
      <h3 className="font-semibold">Dated trip evidence</h3><ForecastEvidence evidence={{ accountId: active.result.accountId, liquidity: active.result.tripLiquidity }} />
    </div>}
  </>;
}
