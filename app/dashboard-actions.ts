"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { cardWidgetKey, dashboardItems, dashboardLayoutSchema, setWidget, widgetSizesSchema } from "@/lib/finance/dashboard";
import { CARD_SIZE_KEYS, type CardSize } from "@/lib/cards/sizes";

type Workspace = Awaited<ReturnType<typeof requireWorkspace>>;

/** Version-checked write, so two tabs editing Home cannot overwrite each other. Returns the new version, or null when another tab saved first. */
async function writeLayout({ supabase, workspace }: Workspace, version: number, items: string[], sizes?: Record<string, CardSize>) {
  const result = version === 0
    ? await supabase.from("dashboard_layouts").insert({ workspace_id: workspace.id, items, ...(sizes && { sizes }) }).select("version").single()
    : await supabase.from("dashboard_layouts").update({ items, ...(sizes && { sizes }), version: version + 1, updated_at: new Date().toISOString() }).eq("workspace_id", workspace.id).eq("version", version).select("version").maybeSingle();
  // A second tab's first save collides on the primary key instead of the version.
  if (result.error?.code === "23505") return null;
  if (result.error) throw new Error("Dashboard could not be saved; try again");
  return result.data ? result.data.version as number : null;
}

/** Saves Home's widgets, order and widths from the grid. Home already shows the change, so nothing re-renders. */
export async function saveHomeLayout(version: number, items: string[], sizes: Record<string, string>): Promise<{ version: number } | { error: string }> {
  const context = await requireWorkspace();
  const saved = await writeLayout(context, z.number().int().min(0).max(2147483646).parse(version), dashboardLayoutSchema.parse(items), widgetSizesSchema.parse(sizes));
  return saved === null ? { error: "Home changed in another tab" } : { version: saved };
}

export async function saveDashboard(form: FormData) {
  const context = await requireWorkspace();
  const version = z.coerce.number().int().min(0).max(2147483646).parse(form.get("version"));
  const items = dashboardLayoutSchema.parse(form.getAll("enabled"));
  const positions = new Map(items.map(key => [key, z.coerce.number().int().min(1).max(50).parse(form.get(`position:${key}`))]));
  items.sort((a, b) => positions.get(a)! - positions.get(b)!);
  if (await writeLayout(context, version, items) === null) throw new Error("Dashboard changed; reload before saving");
  revalidatePath("/");
  revalidatePath("/settings");
  redirect("/settings");
}

/** The saved Home layout, ready to change. */
async function loadLayout({ supabase, workspace }: Workspace) {
  const layout = await supabase.from("dashboard_layouts").select("items, version").eq("workspace_id", workspace.id).maybeSingle();
  if (layout.error) throw new Error("Dashboard could not be loaded; try again");
  const saved = layout.data ? dashboardLayoutSchema.safeParse(layout.data.items) : null;
  if (saved && !saved.success) throw new Error("Dashboard preferences are invalid; try again");
  return { items: dashboardItems(saved?.data ?? null), version: layout.data?.version ?? 0 };
}

async function setCardOnHome(context: Workspace, cardId: string, on: boolean) {
  const { items, version } = await loadLayout(context);
  const next = setWidget(items, cardWidgetKey(cardId), on);
  if (next.length === items.length) return;
  if (next.length > 50) throw new Error("Home is full; hide a widget on Home first");
  if (await writeLayout(context, version, next) === null) throw new Error("Dashboard changed; reload before saving");
  revalidatePath("/");
}

/**
 * Puts a card version on Home, or moves Home to a newer version. Only the version the user previewed is
 * published, and only if Home still shows what they saw, so two tabs can't publish over each other.
 */
export async function publishCard(id: string, version: number, shown: number | null) {
  const cardId = z.uuid().parse(id);
  const target = z.number().int().min(1).parse(version);
  const previous = z.number().int().min(1).nullable().parse(shown);
  const context = await requireWorkspace();
  const { supabase, workspace } = context;
  const exists = await supabase.from("artifact_card_versions").select("title").eq("workspace_id", workspace.id).eq("card_id", cardId).eq("version", target).maybeSingle();
  if (exists.error || !exists.data) throw new Error("That card version is not available");
  let update = supabase.from("artifact_cards").update({ published_version: target, title: exists.data.title, updated_at: new Date().toISOString() }).eq("workspace_id", workspace.id).eq("id", cardId).is("deleted_at", null);
  // Publishing the same version again is allowed: if the Home layout write below failed (Home full, another tab),
  // the card is published but not on Home, the page says so, and pressing Add to Home again finishes the job.
  update = update.or(`${previous === null ? "published_version.is.null" : `published_version.eq.${previous}`},published_version.eq.${target}`);
  const { data, error } = await update.select("artifact_id").maybeSingle();
  if (error) throw new Error("Card could not be published; try again");
  if (!data) throw new Error("Home changed in another tab; reload before publishing");
  await setCardOnHome(context, cardId, true);
  revalidatePath(`/ai/artifacts/${data.artifact_id}`);
}

/** Takes a card off Home; it stays in the artifact to add again. */
export async function unpublishCard(id: string) {
  const cardId = z.uuid().parse(id);
  const context = await requireWorkspace();
  const { supabase, workspace } = context;
  const { data, error } = await supabase.from("artifact_cards").update({ published_version: null, updated_at: new Date().toISOString() }).eq("workspace_id", workspace.id).eq("id", cardId).select("artifact_id").maybeSingle();
  if (error || !data) throw new Error("Card could not be removed from Home; try again");
  await setCardOnHome(context, cardId, false);
  revalidatePath(`/ai/artifacts/${data.artifact_id}`);
}

async function writeCardSize(id: string, size: string) {
  const cardId = z.uuid().parse(id);
  const parsed = z.enum(CARD_SIZE_KEYS as [CardSize, ...CardSize[]]).parse(size);
  const { supabase, workspace } = await requireWorkspace();
  const { data, error } = await supabase.from("artifact_cards").update({ size: parsed, updated_at: new Date().toISOString() }).eq("workspace_id", workspace.id).eq("id", cardId).select("artifact_id").maybeSingle();
  if (error || !data) throw new Error("Card size could not be saved; try again");
  return data.artifact_id as string;
}

/** A card's size on Home (and in its preview), set from its artifact. */
export async function setCardSize(id: string, size: string) {
  revalidatePath(`/ai/artifacts/${await writeCardSize(id, size)}`);
  revalidatePath("/");
}

/** A card resized on Home: the grid already shows the new width and the card fetches its new body, so nothing re-renders. */
export async function resizeHomeCard(id: string, size: string) {
  await writeCardSize(id, size);
}
