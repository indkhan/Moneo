import Link from "next/link";
import { requireWorkspace } from "@/lib/auth";
import { createArtifact } from "./actions";
import { GenerateForm } from "./generate-form";

const kinds = [
  { kind: "spending_explorer", name: "Spending Explorer" },
  { kind: "trip_planner", name: "Trip Planner" },
  { kind: "goal_tracker", name: "Goal Tracker" },
  { kind: "custom_planner", name: "Custom Planner" },
  { kind: "custom_tracker", name: "Custom Tracker" },
  { kind: "custom_report", name: "Custom Report" },
  { kind: "custom_comparison", name: "Custom Comparison" },
] as const;

export default async function Library() {
  const { supabase, workspace } = await requireWorkspace();
  const { data: artifacts, error } = await supabase.from("artifacts")
    .select("id, kind, name, created_at, active_version_id")
    .eq("workspace_id", workspace.id).order("created_at", { ascending: false });
  if (error) throw error;
  return <main className="mx-auto max-w-5xl px-5 py-8 lg:px-8">
    <Link href="/ai" className="text-sm underline">AI</Link>
    <p className="mt-5 text-xs font-semibold uppercase tracking-widest text-brand">AI / Library</p>
    <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground">Library</h1>
    <p className="mt-2 text-muted-foreground">Saved financial tools read your current data when opened.</p>
    <div className="mt-6 grid gap-3 sm:grid-cols-3">{kinds.map(item =>
      <form key={item.kind} action={createArtifact} className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <input type="hidden" name="kind" value={item.kind} />
        <label className="block text-sm font-medium" htmlFor={item.kind}>{item.name}</label>
        <input id={item.kind} name="name" defaultValue={item.name} required maxLength={120} className="mt-3 w-full rounded-lg border border-border bg-card px-3 py-2" />
        <button className="mt-3 rounded-lg bg-brand px-3 py-2 font-medium text-white hover:opacity-90 text-sm">Create</button>
      </form>)}</div>
    <GenerateForm />
    <h2 className="mt-10 text-xl font-semibold tracking-tight text-foreground">Saved tools</h2>
    {!artifacts?.length && <p className="mt-3 text-muted-foreground">No tools saved yet.</p>}
    <ul className="mt-3 space-y-2">{artifacts?.map(artifact =>
      <li key={artifact.id} className="rounded-xl border border-border bg-card p-4 shadow-sm"><Link className="underline" href={`/ai/library/${artifact.id}`}>{artifact.name}</Link>
        <span className="ml-3 text-xs text-muted-foreground">{artifact.kind.replaceAll("_", " ")}{artifact.active_version_id ? "" : " · unavailable"}</span></li>)}</ul>
  </main>;
}
