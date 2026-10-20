"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { dashboardLayoutSchema } from "@/lib/finance/dashboard";

export async function saveDashboard(form: FormData) {
  const { supabase, workspace } = await requireWorkspace();
  const version = z.coerce.number().int().min(0).max(2147483646).parse(form.get("version"));
  const items = dashboardLayoutSchema.parse(form.getAll("enabled"));
  const positions = new Map(items.map(key => [key, z.coerce.number().int().min(1).max(50).parse(form.get(`position:${key}`))]));
  items.sort((a, b) => positions.get(a)! - positions.get(b)!);
  const result = version === 0
    ? await supabase.from("dashboard_layouts").insert({ workspace_id: workspace.id, items }).select("version").single()
    : await supabase.from("dashboard_layouts").update({ items, version: version + 1, updated_at: new Date().toISOString() }).eq("workspace_id", workspace.id).eq("version", version).select("version").maybeSingle();
  if (result.error) throw new Error("Dashboard could not be saved; reload before retrying");
  if (!result.data) throw new Error("Dashboard changed; reload before saving");
  revalidatePath("/");
  revalidatePath("/settings");
  redirect("/settings");
}
