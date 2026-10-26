"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { artifactWidgetKey, dashboardItems, dashboardLayoutSchema, setWidget } from "@/lib/finance/dashboard";

type Workspace = Awaited<ReturnType<typeof requireWorkspace>>;

/** Version-checked write, so two tabs editing Home cannot overwrite each other. */
async function writeLayout({ supabase, workspace }: Workspace, version: number, items: string[]) {
  const result = version === 0
    ? await supabase.from("dashboard_layouts").insert({ workspace_id: workspace.id, items }).select("version").single()
    : await supabase.from("dashboard_layouts").update({ items, version: version + 1, updated_at: new Date().toISOString() }).eq("workspace_id", workspace.id).eq("version", version).select("version").maybeSingle();
  if (result.error) throw new Error("Dashboard could not be saved; reload before retrying");
  if (!result.data) throw new Error("Dashboard changed; reload before saving");
  revalidatePath("/");
}

export async function saveDashboard(form: FormData) {
  const context = await requireWorkspace();
  const version = z.coerce.number().int().min(0).max(2147483646).parse(form.get("version"));
  const items = dashboardLayoutSchema.parse(form.getAll("enabled"));
  const positions = new Map(items.map(key => [key, z.coerce.number().int().min(1).max(50).parse(form.get(`position:${key}`))]));
  items.sort((a, b) => positions.get(a)! - positions.get(b)!);
  await writeLayout(context, version, items);
  revalidatePath("/settings");
  redirect("/settings");
}

/** Pins an artifact to Home (its compact widget view) or takes it off. */
export async function setArtifactOnHome(id: string, onHome: boolean) {
  const artifactId = z.uuid().parse(id);
  const context = await requireWorkspace();
  const { supabase, workspace } = context;
  const [layout, artifact] = await Promise.all([
    supabase.from("dashboard_layouts").select("items, version").eq("workspace_id", workspace.id).maybeSingle(),
    supabase.from("artifacts").select("id").eq("workspace_id", workspace.id).eq("id", artifactId).is("deleted_at", null).maybeSingle(),
  ]);
  if (layout.error || artifact.error) throw new Error("Dashboard could not be loaded; try again");
  if (onHome && !artifact.data) throw new Error("Artifact not found");
  const saved = layout.data ? dashboardLayoutSchema.safeParse(layout.data.items) : null;
  if (saved && !saved.success) throw new Error("Dashboard preferences are invalid; review them in Settings");
  const current = dashboardItems(saved?.data ?? null);
  const items = setWidget(current, artifactWidgetKey(artifactId), onHome);
  if (items.length === current.length) return;
  if (items.length > 50) throw new Error("Home is full; remove a widget in Settings first");
  await writeLayout(context, layout.data?.version ?? 0, items);
  revalidatePath(`/ai/artifacts/${artifactId}`);
}
