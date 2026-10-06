import Link from "next/link";
import { notFound } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { goalsForArtifact, spendingForArtifact, tripForArtifact } from "@/lib/artifacts/finance-sdk";
import { buildCalculatorSnapshot } from "@/lib/artifacts/snapshot";
import { defaultParams } from "@/lib/artifacts/validate";
import { artifactKindSchema, calculatorManifestSchema, type ArtifactKind } from "@/lib/artifacts/spec";
import { parseManualAmount } from "@/app/money/transactions/input";
import { calendarDate } from "@/lib/finance/calendar";
import { formatMoney } from "@/lib/finance/format";
import { pinArtifact, renameArtifact, saveTripState, unpinArtifact } from "../actions";
import { SpendingChart } from "../spending-chart";
import { CalculatorPanel } from "../calculator-panel";
import { GenerateCalculatorForm } from "../generate-calculator-form";
import { VersionEditor } from "../version-editor";

function money(minor: bigint | string | number, currency: string) {
  return formatMoney(minor, currency);
}

const kinds: ArtifactKind[] = artifactKindSchema.options;

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
      const defaults = defaultParams(manifestParsed.data);
      initialParams = { ...defaults };
      for (const [k, v] of Object.entries(stateValue)) {
        if (k in defaults && typeof v === typeof defaults[k]) initialParams[k] = v as number | string;
      }
      const built = await buildCalculatorSnapshot(id, kind, {
        query: q.slice(0, 100),
        month: typeof initialParams.month === "string" ? initialParams.month : undefined,
        costMinor,
        sdk: manifestParsed.data.sdk,
      });
      snapshot = built.snapshot;
      // Trip cost also flows from legacy trip state for compatibility.
      if (kind === "trip_planner" && "costMinor" in defaults) {
        initialParams.costMinor = Number(costMinor);
      }
    } catch {
      snapshot = { unavailable: "Snapshot unavailable" };
      initialParams = manifestParsed.success ? defaultParams(manifestParsed.data) : {};
    }
  }

  return <main className="mx-auto max-w-5xl px-5 py-8 lg:px-8">
    <Link href="/ai/library" className="text-sm underline">Library</Link>
    <p className="mt-5 text-xs font-semibold uppercase tracking-widest text-brand">AI / Saved tool</p>
    <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-3xl font-semibold tracking-tight text-foreground">{artifact.name}</h1>
      <form action={pin ? unpinArtifact : pinArtifact}>
        <input type="hidden" name="artifactId" value={id} />
        <button className="rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-muted">{pin ? "Unpin from Home" : "Pin to Home"}</button>
      </form>
    </div>
    <p className="mt-2 text-sm text-muted-foreground">Live financial data · trusted {artifact.kind.replaceAll("_", " ")} v{version?.version ?? "?"}</p>
    <form action={renameArtifact} className="mt-4 flex flex-wrap gap-2 text-sm">
      <input type="hidden" name="artifactId" value={id} />
      <input name="name" defaultValue={artifact.name} required maxLength={120} aria-label="Artifact name" className="rounded-lg border border-border bg-card px-3 py-2" />
      <button className="rounded-lg border border-border bg-card px-3 text-sm font-medium hover:bg-muted">Save new version</button>
    </form>
    {artifact.kind === "spending_explorer" && <SpendingExplorer id={id} query={q.slice(0, 100)} />}
    {artifact.kind === "trip_planner" && <TripPlanner id={id} costMinor={costMinor} />}
    {artifact.kind === "goal_tracker" && <GoalTracker id={id} scenarioGoalId={goalId} extra={extra} />}
    {version && isCalculator && (
      <CalculatorPanel
        key={artifact.active_version_id}
        source={version.source}
        snapshot={snapshot}
        initialParams={initialParams}
        versionLabel={`v${version.version}`}
        artifactId={id}
        title={artifact.name}
        locale={workspace.locale}
      />
    )}
    {version && !isCalculator && (
      <p className="mt-8 rounded-xl border border-border bg-card p-5 shadow-sm text-sm text-muted-foreground">
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
  </main>;
}

async function SpendingExplorer({ id, query }: { id: string; query: string }) {
  let data: Awaited<ReturnType<typeof spendingForArtifact>>;
  try { data = await spendingForArtifact(id, query); }
  catch { return <p role="status" className="mt-8 rounded border p-5">Spending evidence is unavailable. Check this tool&apos;s permissions and AI data access in Settings.</p>; }
  return <section className="mt-8 rounded-xl border border-border bg-card p-5 shadow-sm">
    <h2 className="text-xl font-semibold tracking-tight text-foreground">This month</h2>
    {"unavailable" in data.summary ? <p className="mt-3">{data.summary.unavailable}</p>
      : <p className="mt-3 text-2xl">Spending {money(data.summary.spendingMinor, data.currency)}</p>}
    <p className="mt-1 text-sm text-muted-foreground">{data.from} to {data.to} ({data.timezone}). Posted transactions matching the filter, including refunds; transfers excluded. Mixed currencies require dated conversion evidence.</p>
    {!("unavailable" in data.summary) && data.summary.partial && <p role="status" className="mt-2 text-sm text-amber-700">Partial: {data.summary.excludedReviewRows} transactions need classification review and are excluded from these totals.</p>}
    {!("unavailable" in data.summary) && <SpendingChart rows={data.transactions} from={data.from} to={data.to} currency={data.currency} />}
    <form method="get" className="mt-5 flex gap-2">
      <input name="q" defaultValue={query} maxLength={100} aria-label="Filter transaction descriptions" className="flex-1 rounded-lg border border-border bg-card px-3 py-2" placeholder="Filter descriptions" />
      <button className="rounded-lg border border-border bg-card px-3 text-sm font-medium hover:bg-muted">Filter</button>
    </form>
    <ul className="mt-4 divide-y rounded border">{data.transactions.map(row =>
      <li key={row.id} className="flex justify-between gap-3 p-3 text-sm">
        <span className="min-w-0 flex-1 break-words">{row.posted_on} · <Link href="/money/transactions" className="underline">{row.description}</Link></span>
        <span className="shrink-0 whitespace-nowrap">{money(row.amount_minor, row.currency_code)}</span>
      </li>)}</ul>
    {!data.transactions.length && <p className="mt-4">No matching transactions.</p>}
  </section>;
}

async function TripPlanner({ id, costMinor }: { id: string; costMinor: bigint }) {
  let data: Awaited<ReturnType<typeof tripForArtifact>>;
  try { data = await tripForArtifact(id, costMinor); }
  catch { return <p role="status" className="mt-8 rounded border p-5">Forecast evidence is unavailable. Check this tool&apos;s permissions and AI data access in Settings.</p>; }
  return <section className="mt-8 rounded-xl border border-border bg-card p-5 shadow-sm">
    <h2 className="text-xl font-semibold tracking-tight text-foreground">Trip cost</h2>
    <form action={saveTripState} className="mt-4 flex flex-wrap items-end gap-3">
      <input type="hidden" name="artifactId" value={id} />
      <label className="text-sm">Cost in minor units ({data.currency})<input name="costMinor" type="number" min="0" max="10000000" defaultValue={costMinor.toString()} className="mt-1 block rounded-lg border border-border bg-card px-3 py-2" /></label>
      <button className="rounded-lg bg-brand px-3 py-2 font-medium text-white hover:opacity-90 text-sm">Save and recalculate</button>
    </form>
    <p className="mt-3 text-sm text-muted-foreground">Hypothetical one-time cost on {data.tripDate}; no goal or account is changed.</p>
    {data.unavailable && <p className="mt-4">{data.unavailable}</p>}
    <div className="mt-5 grid gap-3 sm:grid-cols-2">
      <div className="rounded-xl border border-border bg-card p-5 shadow-sm"><h3>Available to spend now</h3><p className="mt-2 text-xl">{data.baseline.status === "available" ? money(data.baseline.amountMinor, data.currency) : "Unavailable"}</p></div>
      <div className="rounded-xl border border-border bg-card p-5 shadow-sm"><h3>With trip cost</h3><p className="mt-2 text-xl">{data.withTrip?.status === "available" ? money(data.withTrip.amountMinor, data.currency) : "Unavailable"}</p></div>
    </div>
  </section>;
}

async function GoalTracker({ id, scenarioGoalId, extra }: { id: string; scenarioGoalId: string; extra: string }) {
  let data: Awaited<ReturnType<typeof goalsForArtifact>>;
  try { data = await goalsForArtifact(id); }
  catch { return <p role="status" className="mt-8 rounded border p-5">Goal evidence is unavailable. Check this tool&apos;s permissions and AI data access in Settings.</p>; }
  const today = calendarDate(new Date(), data.timezone);
  const accountCurrencies = new Map(data.balances.map(item => [item.id, item.currency_code]));
  const targetGoal = data.goals.find(g => g.id === scenarioGoalId);
  const extraCurrency = targetGoal?.currency_code ?? "EUR";
  let extraMinor = 0n;
  try { if (extra) extraMinor = parseManualAmount(extra, extraCurrency); } catch { /* Ignore invalid what-if input. */ }
  return <section className="mt-8 rounded-xl border border-border bg-card p-5 shadow-sm">
    <h2 className="text-xl font-semibold tracking-tight text-foreground">Goals and reservations</h2>
    {!data.goals.length && <p className="mt-3">No goals yet. <Link href="/plan" className="underline">Create a goal</Link>.</p>}
    <div className="mt-4 space-y-3">{data.goals.map(goal => {
      const goalAllocations = data.allocations.filter(item => item.goal_id === goal.id);
      const comparable = goalAllocations.every(item => accountCurrencies.get(item.account_id) === goal.currency_code);
      const reserved = goalAllocations
        .reduce((sum, item) => sum + BigInt(item.amount_minor), 0n);
      const saved = goal.recorded_saved_minor !== null && goal.saved_as_of && goal.saved_as_of <= today ? BigInt(goal.recorded_saved_minor) : null;
      const remaining = saved === null ? null : BigInt(goal.target_minor) > saved ? BigInt(goal.target_minor) - saved : 0n;
      const days = goal.target_date ? Math.max(1, Math.ceil((Date.parse(`${goal.target_date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000)) : null;
      const pace = days && remaining !== null ? (remaining * 30n + BigInt(days) - 1n) / BigInt(days) : null;
      const projected = days && saved !== null && scenarioGoalId === goal.id ? saved + extraMinor * BigInt(days) / 30n : null;
      return <article key={goal.id} className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <h3 className="font-medium">{goal.name}</h3>
        <p className="mt-2">Recorded savings {saved === null ? "unknown" : `${money(saved, goal.currency_code)} as of ${goal.saved_as_of}`} of {money(goal.target_minor, goal.currency_code)}</p>
        <p className="mt-1 text-sm">Virtual reservations {comparable ? money(reserved, goal.currency_code) : "unavailable across currencies"}. Reservations are separate from recorded savings.</p>
        <p className="mt-1 text-sm text-muted-foreground">{goal.target_date ? `Target ${goal.target_date} · ${pace !== null ? `about ${money(pace, goal.currency_code)} per 30 days still needed` : "saving pace unavailable"}` : "No target date"}</p>
        <form method="get" className="mt-3 flex flex-wrap items-end gap-2 text-sm">
          <input type="hidden" name="goalId" value={goal.id} />
          <label>What if I save monthly?<input name="extra" type="number" step="0.01" min="0" defaultValue={scenarioGoalId === goal.id ? extra : ""} className="mt-1 block w-32 rounded-lg border border-border bg-card px-3 py-2" /></label>
          <button className="rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-muted">Calculate</button>
        </form>
        {projected !== null && <p className="mt-2 text-sm">Illustrative amount at target date: {money(projected, goal.currency_code)}</p>}
      </article>;
    })}</div>
    <p className="mt-4 text-xs text-muted-foreground">Reservations are virtual. Different account currencies require conversion before totals can be compared.</p>
  </section>;
}
