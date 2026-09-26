import Link from "next/link";
import { notFound } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { goalsForArtifact, spendingForArtifact, tripForArtifact } from "@/lib/artifacts/finance-sdk";
import { buildCalculatorSnapshot } from "@/lib/artifacts/snapshot";
import { defaultParams } from "@/lib/artifacts/validate";
import { calculatorManifestSchema, type ArtifactKind } from "@/lib/artifacts/spec";
import { parseAmountMinor } from "@/lib/csv";
import { pinArtifact, renameArtifact, saveTripState, unpinArtifact } from "../actions";
import { SpendingChart } from "../spending-chart";
import { RuntimeCheck } from "../runtime-check";
import { CalculatorPanel } from "../calculator-panel";
import { GenerateCalculatorForm } from "../generate-calculator-form";
import { VersionEditor } from "../version-editor";

function money(minor: bigint | string | number, currency: string) {
  const value = BigInt(minor);
  const abs = value < 0n ? -value : value;
  return `${value < 0n ? "−" : ""}${currency} ${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

const kinds: ArtifactKind[] = ["spending_explorer", "trip_planner", "goal_tracker"];

export default async function ArtifactPage({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string; goalId?: string; extra?: string }>;
}) {
  const { id } = await params;
  const { q = "", goalId = "", extra = "" } = await searchParams;
  const { supabase, workspace } = await requireWorkspace();
  const [{ data: artifact }, { data: state }, { data: pin }] = await Promise.all([
    supabase.from("artifacts").select("id, kind, name, active_version_id")
      .eq("workspace_id", workspace.id).eq("id", id).maybeSingle(),
    supabase.from("artifact_state").select("state").eq("workspace_id", workspace.id).eq("artifact_id", id).maybeSingle(),
    supabase.from("dashboard_items").select("id").eq("workspace_id", workspace.id).eq("artifact_id", id).maybeSingle(),
  ]);
  if (!artifact?.active_version_id || !kinds.includes(artifact.kind as ArtifactKind)) notFound();
  const kind = artifact.kind as ArtifactKind;
  const [{ data: version }, { data: versions }] = await Promise.all([
    supabase.from("artifact_versions").select("version, source, manifest")
      .eq("workspace_id", workspace.id).eq("id", artifact.active_version_id).single(),
    supabase.from("artifact_versions").select("id, version, status, error, created_at, manifest, source")
      .eq("workspace_id", workspace.id).eq("artifact_id", id).order("version", { ascending: false }).limit(20),
  ]);
  const stateValue = (state?.state ?? {}) as Record<string, number | string>;
  const costMinor = Number.isSafeInteger((stateValue as { costMinor?: number }).costMinor) && (stateValue as { costMinor?: number }).costMinor! >= 0
    ? BigInt((stateValue as { costMinor?: number }).costMinor!) : 90000n;

  const manifestParsed = calculatorManifestSchema.safeParse(version?.manifest);
  const isCalculator = manifestParsed.success;
  let snapshot: unknown = { kind };
  let initialParams: Record<string, number | string> = {};
  if (isCalculator && version) {
    try {
      const built = await buildCalculatorSnapshot(id, kind, {
        query: q.slice(0, 100),
        costMinor,
      });
      snapshot = built.snapshot;
      const defaults = defaultParams(manifestParsed.data);
      initialParams = { ...defaults };
      for (const [k, v] of Object.entries(stateValue)) {
        if (k in defaults && typeof v === typeof defaults[k]) initialParams[k] = v as number | string;
      }
      // Trip cost also flows from legacy trip state for compatibility.
      if (kind === "trip_planner" && "costMinor" in defaults) {
        initialParams.costMinor = Number(costMinor);
      }
    } catch {
      snapshot = { unavailable: "Snapshot unavailable" };
      initialParams = manifestParsed.success ? defaultParams(manifestParsed.data) : {};
    }
  }

  return <main className="mx-auto max-w-4xl px-6 py-10">
    <Link href="/ai/library" className="text-sm underline">Library</Link>
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-3xl font-semibold">{artifact.name}</h1>
      <form action={pin ? unpinArtifact : pinArtifact}>
        <input type="hidden" name="artifactId" value={id} />
        <button className="rounded border px-3 py-2 text-sm">{pin ? "Unpin from Home" : "Pin to Home"}</button>
      </form>
    </div>
    <p className="mt-2 text-sm text-muted-foreground">Live financial data · trusted {artifact.kind.replaceAll("_", " ")} v{version?.version ?? "?"}</p>
    <form action={renameArtifact} className="mt-4 flex flex-wrap gap-2 text-sm">
      <input type="hidden" name="artifactId" value={id} />
      <input name="name" defaultValue={artifact.name} required maxLength={120} aria-label="Artifact name" className="rounded border p-2" />
      <button className="rounded border px-3">Save new version</button>
    </form>
    {artifact.kind === "spending_explorer" && <SpendingExplorer id={id} query={q.slice(0, 100)} />}
    {artifact.kind === "trip_planner" && <TripPlanner id={id} costMinor={costMinor} />}
    {artifact.kind === "goal_tracker" && <GoalTracker id={id} scenarioGoalId={goalId} extra={extra} />}
    {version && isCalculator && (
      <CalculatorPanel
        source={version.source}
        snapshot={snapshot}
        initialParams={initialParams}
        versionLabel={`v${version.version}`}
        artifactId={id}
      />
    )}
    {version && !isCalculator && (
      <p className="mt-8 rounded-lg border p-4 text-sm text-muted-foreground">
        This tool still uses the built-in trusted template (no generated calculator yet). Use the
        generator below to draft the first validated calculator version.
      </p>
    )}
    <GenerateCalculatorForm artifactId={id} kind={kind} />
    {version && (
      <VersionEditor
        artifactId={id}
        activeVersionId={artifact.active_version_id}
        versions={(versions ?? []).map((v) => ({
          id: v.id, version: v.version, status: v.status,
          error: v.error, created_at: v.created_at, manifest: v.manifest, source: v.source,
        }))}
        currentSource={version.source}
        currentManifest={version.manifest}
      />
    )}
    {version && <RuntimeCheck source={version.source} input={{ kind: artifact.kind, snapshot, params: initialParams }} />}
  </main>;
}

async function SpendingExplorer({ id, query }: { id: string; query: string }) {
  const data = await spendingForArtifact(id, query);
  return <section className="mt-8">
    <h2 className="text-xl font-semibold">This month</h2>
    {"unavailable" in data.summary ? <p className="mt-3">{data.summary.unavailable}</p>
      : <p className="mt-3 text-2xl">Spending {money(data.summary.spendingMinor, data.currency)}</p>}
    <p className="mt-1 text-sm text-muted-foreground">{data.from} to {data.to}. Posted ordinary transactions only; mixed currencies remain unavailable.</p>
    <SpendingChart rows={data.transactions} />
    <form method="get" className="mt-5 flex gap-2">
      <input name="q" defaultValue={query} maxLength={100} aria-label="Filter transaction descriptions" className="flex-1 rounded border p-2" placeholder="Filter descriptions" />
      <button className="rounded border px-3">Filter</button>
    </form>
    <ul className="mt-4 divide-y rounded border">{data.transactions.map(row =>
      <li key={row.id} className="flex justify-between gap-3 p-3 text-sm">
        <span>{row.posted_on} · <Link href="/money/transactions" className="underline">{row.description}</Link></span>
        <span>{money(row.amount_minor, row.currency_code)}</span>
      </li>)}</ul>
    {!data.transactions.length && <p className="mt-4">No matching transactions.</p>}
    {data.transactions.length === 50 && <p className="mt-2 text-xs text-muted-foreground">Showing the latest 50 matching transactions.</p>}
  </section>;
}

async function TripPlanner({ id, costMinor }: { id: string; costMinor: bigint }) {
  const data = await tripForArtifact(id, costMinor);
  return <section className="mt-8">
    <h2 className="text-xl font-semibold">Trip cost</h2>
    <form action={saveTripState} className="mt-4 flex flex-wrap items-end gap-3">
      <input type="hidden" name="artifactId" value={id} />
      <label className="text-sm">Cost in minor units ({data.currency})<input name="costMinor" type="number" min="0" max="10000000" defaultValue={costMinor.toString()} className="mt-1 block rounded border p-2" /></label>
      <button className="rounded bg-primary px-3 py-2 text-sm text-primary-foreground">Save and recalculate</button>
    </form>
    <p className="mt-3 text-sm text-muted-foreground">Hypothetical one-time cost on {data.tripDate}; no goal or account is changed.</p>
    {data.unavailable && <p className="mt-4">{data.unavailable}</p>}
    <div className="mt-5 grid gap-3 sm:grid-cols-2">
      <div className="rounded border p-4"><h3>Available to spend now</h3><p className="mt-2 text-xl">{data.baseline.status === "available" ? money(data.baseline.amountMinor, data.currency) : "Unavailable"}</p></div>
      <div className="rounded border p-4"><h3>With trip cost</h3><p className="mt-2 text-xl">{data.withTrip?.status === "available" ? money(data.withTrip.amountMinor, data.currency) : "Unavailable"}</p></div>
    </div>
  </section>;
}

async function GoalTracker({ id, scenarioGoalId, extra }: { id: string; scenarioGoalId: string; extra: string }) {
  const data = await goalsForArtifact(id);
  const today = new Date().toISOString().slice(0, 10);
  const accountCurrencies = new Map(data.balances.map(item => [item.id, item.currency_code]));
  let extraMinor = 0n;
  try { if (extra) extraMinor = parseAmountMinor(extra); } catch { /* Ignore invalid what-if input. */ }
  return <section className="mt-8">
    <h2 className="text-xl font-semibold">Goals and reservations</h2>
    {!data.goals.length && <p className="mt-3">No goals yet. <Link href="/plan" className="underline">Create a goal</Link>.</p>}
    <div className="mt-4 space-y-3">{data.goals.map(goal => {
      const goalAllocations = data.allocations.filter(item => item.goal_id === goal.id);
      const comparable = goalAllocations.every(item => accountCurrencies.get(item.account_id) === goal.currency_code);
      const saved = goalAllocations
        .reduce((sum, item) => sum + BigInt(item.amount_minor), 0n);
      const remaining = BigInt(goal.target_minor) > saved ? BigInt(goal.target_minor) - saved : 0n;
      const days = goal.target_date ? Math.max(1, Math.ceil((Date.parse(`${goal.target_date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000)) : null;
      const pace = days ? (remaining * 30n + BigInt(days) - 1n) / BigInt(days) : null;
      const projected = days && comparable && scenarioGoalId === goal.id ? saved + extraMinor * BigInt(days) / 30n : null;
      return <article key={goal.id} className="rounded border p-4">
        <h3 className="font-medium">{goal.name}</h3>
        <p className="mt-2">Reserved {comparable ? money(saved, goal.currency_code) : "Unavailable across currencies"} of {money(goal.target_minor, goal.currency_code)}</p>
        <p className="mt-1 text-sm text-muted-foreground">{goal.target_date ? `Target ${goal.target_date} · ${comparable && pace ? `about ${money(pace, goal.currency_code)} per 30 days still needed` : "saving pace unavailable"}` : "No target date"}</p>
        <form method="get" className="mt-3 flex flex-wrap items-end gap-2 text-sm">
          <input type="hidden" name="goalId" value={goal.id} />
          <label>What if I save monthly?<input name="extra" type="number" step="0.01" min="0" defaultValue={scenarioGoalId === goal.id ? extra : ""} className="mt-1 block w-32 rounded border p-2" /></label>
          <button className="rounded border px-3 py-2">Calculate</button>
        </form>
        {projected !== null && <p className="mt-2 text-sm">Illustrative amount at target date: {money(projected, goal.currency_code)}</p>}
      </article>;
    })}</div>
    <p className="mt-4 text-xs text-muted-foreground">Reservations are virtual. Different account currencies require conversion before totals can be compared.</p>
  </section>;
}
