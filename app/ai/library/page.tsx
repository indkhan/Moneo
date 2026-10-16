import Link from "next/link";
import { requireWorkspace } from "@/lib/auth";
import { LIBRARY_TEMPLATES } from "@/lib/artifacts/library-templates";
import { previewTemplate } from "@/lib/artifacts/template-preview";
import { calculatorManifestSchema } from "@/lib/artifacts/spec";
import { createArtifact } from "./actions";
import { GenerateForm } from "./generate-form";
import { LibraryGallery, type GalleryTool } from "./library-gallery";
import { TemplateGallery } from "./template-gallery";

const kinds = [
  { kind: "custom_report", name: "Custom Report", hint: "Summaries of any operation" },
  { kind: "custom_tracker", name: "Custom Tracker", hint: "Track a measure over time" },
  { kind: "custom_planner", name: "Custom Planner", hint: "Plans and what-ifs" },
  { kind: "custom_comparison", name: "Custom Comparison", hint: "Compare scenarios or accounts" },
  { kind: "spending_explorer", name: "Spending Explorer", hint: "Built-in spending view" },
  { kind: "trip_planner", name: "Trip Planner", hint: "Built-in dated trip budget" },
  { kind: "goal_tracker", name: "Goal Tracker", hint: "Built-in goals and reservations" },
] as const;

export default async function Library() {
  const { supabase, workspace } = await requireWorkspace();
  const [{ data: artifacts, error }, { data: pins, error: pinError }, previews] = await Promise.all([
    supabase.from("artifacts").select("id, kind, name, updated_at, active_version_id")
      .eq("workspace_id", workspace.id).order("updated_at", { ascending: false }),
    supabase.from("dashboard_items").select("artifact_id").eq("workspace_id", workspace.id),
    Promise.all(LIBRARY_TEMPLATES.map(template => previewTemplate(template).catch(() => null))),
  ]);
  if (error) throw error;
  if (pinError) throw pinError;
  const activeIds = (artifacts ?? []).flatMap(artifact => artifact.active_version_id ? [artifact.active_version_id] : []);
  const { data: versions, error: versionError } = activeIds.length
    ? await supabase.from("artifact_versions").select("id, version, manifest").eq("workspace_id", workspace.id).in("id", activeIds)
    : { data: [], error: null };
  if (versionError) throw versionError;
  const pinned = new Set((pins ?? []).map(pin => pin.artifact_id));
  const byId = new Map((versions ?? []).map(version => [version.id, version]));
  const tools: GalleryTool[] = (artifacts ?? []).map(artifact => {
    const version = artifact.active_version_id ? byId.get(artifact.active_version_id) : undefined;
    const manifest = calculatorManifestSchema.safeParse(version?.manifest);
    return {
      id: artifact.id, kind: artifact.kind, name: artifact.name, updatedAt: artifact.updated_at,
      version: version?.version ?? null, available: Boolean(artifact.active_version_id), pinned: pinned.has(artifact.id),
      sdk: manifest.success ? manifest.data.sdk : [],
      inputs: manifest.success ? Object.entries(manifest.data.params).map(([name, def]) => def.label ?? name) : [],
      generated: manifest.success,
    };
  });

  return <main className="mx-auto max-w-7xl space-y-10 px-5 py-8 lg:px-8">
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <nav aria-label="Breadcrumb" className="text-sm text-muted-foreground"><Link href="/ai" className="hover:text-foreground hover:underline">AI</Link> <span aria-hidden>/</span> Library</nav>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight text-foreground">Library</h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">Calculators, dashboards and charts that run in an isolated sandbox against your current data. Saved tools read live evidence each time they open.</p>
      </div>
      <Link href="/ai/library/sdk" className="rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-muted">SDK reference</Link>
    </header>

    <LibraryGallery tools={tools} />

    <section aria-labelledby="templates-heading">
      <h2 id="templates-heading" className="text-lg font-semibold tracking-tight">Start from a template</h2>
      <p className="mt-1 text-sm text-muted-foreground">Reviewed code that goes through the same validation as your own edits. Edit anything after creating it.</p>
      <TemplateGallery templates={LIBRARY_TEMPLATES.map((template, index) => ({ id: template.id, name: template.name, description: template.description, kind: template.kind, preview: previews[index], sample: Boolean(template.sample) }))} currency={workspace.display_currency} locale={workspace.locale} />
    </section>

    <GenerateForm />

    <section aria-labelledby="blank-heading">
      <h2 id="blank-heading" className="text-lg font-semibold tracking-tight">Start blank</h2>
      <p className="mt-1 text-sm text-muted-foreground">Custom kinds can read any SDK operation you declare. Built-in kinds include their own host view.</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{kinds.map(item =>
        <form key={item.kind} action={createArtifact} className="flex flex-col rounded-xl border border-border bg-card p-4 shadow-sm">
          <input type="hidden" name="kind" value={item.kind} />
          <label className="text-sm font-medium" htmlFor={item.kind}>{item.name}</label>
          <span className="text-xs text-muted-foreground">{item.hint}</span>
          <div className="mt-3 flex gap-2">
            <input id={item.kind} name="name" defaultValue={item.name} required maxLength={120} className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm" />
            <button className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm font-medium hover:bg-muted">Create</button>
          </div>
        </form>)}</div>
    </section>
  </main>;
}
