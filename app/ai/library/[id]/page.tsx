import Link from "next/link";
import { notFound } from "next/navigation";
import { requireWorkspace } from "@/lib/auth";
import { goalsForArtifact, spendingForArtifact, tripForArtifact } from "@/lib/artifacts/finance-sdk";
import { parseAmountMinor } from "@/lib/csv";
import { pinArtifact, renameArtifact, saveTripState, unpinArtifact } from "../actions";
import { SpendingChart } from "../spending-chart";
import { RuntimeCheck } from "../runtime-check";

function money(minor: bigint | string | number, currency: string) {
  const value = BigInt(minor);
  const abs = value < 0n ? -value : value;
  return `${value < 0n ? "−" : ""}${currency} ${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

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
  if (!artifact?.active_version_id) notFound();
  const { data: version } = await supabase.from("artifact_versions").select("version, source")
    .eq("workspace_id", workspace.id).eq("id", artifact.active_version_id).single();
  const stateValue = state?.state as { costMinor?: number } | null;
  const costMinor = Number.isSafeInteger(stateValue?.costMinor) && stateValue!.costMinor! >= 0 ? BigInt(stateValue!.costMinor!) : 90000n;

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
    {version && <RuntimeCheck source={version.source} input={{ kind: artifact.kind }} />}
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
