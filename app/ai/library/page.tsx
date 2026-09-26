import Link from "next/link";
import { requireWorkspace } from "@/lib/auth";
import { createArtifact } from "./actions";
import { RuntimeCheck } from "./runtime-check";

const kinds = [
  { kind: "spending_explorer", name: "Spending Explorer" },
  { kind: "trip_planner", name: "Trip Planner" },
  { kind: "goal_tracker", name: "Goal Tracker" },
] as const;

export default async function Library() {
  const { supabase, workspace } = await requireWorkspace();
  const { data: artifacts, error } = await supabase.from("artifacts")
    .select("id, kind, name, created_at, active_version_id")
    .eq("workspace_id", workspace.id).order("created_at", { ascending: false });
  if (error) throw error;
  return <main className="mx-auto max-w-4xl px-6 py-10">
    <Link href="/ai" className="text-sm underline">AI</Link>
    <h1 className="mt-4 text-3xl font-semibold">Library</h1>
    <p className="mt-2 text-muted-foreground">Saved financial tools read your current data when opened.</p>
    <div className="mt-6 grid gap-3 sm:grid-cols-3">{kinds.map(item =>
      <form key={item.kind} action={createArtifact} className="rounded-lg border p-4">
        <input type="hidden" name="kind" value={item.kind} />
        <label className="block text-sm font-medium" htmlFor={item.kind}>{item.name}</label>
        <input id={item.kind} name="name" defaultValue={item.name} required maxLength={120} className="mt-3 w-full rounded border p-2" />
        <button className="mt-3 rounded bg-primary px-3 py-2 text-sm text-primary-foreground">Create</button>
      </form>)}</div>
    <h2 className="mt-10 text-xl font-semibold">Saved tools</h2>
    {!artifacts?.length && <p className="mt-3 text-muted-foreground">No tools saved yet.</p>}
    <ul className="mt-3 space-y-2">{artifacts?.map(artifact =>
      <li key={artifact.id} className="rounded border p-3"><Link className="underline" href={`/ai/library/${artifact.id}`}>{artifact.name}</Link>
        <span className="ml-3 text-xs text-muted-foreground">{artifact.kind.replaceAll("_", " ")}{artifact.active_version_id ? "" : " · unavailable"}</span></li>)}</ul>
    <RuntimeCheck />
  </main>;
}
