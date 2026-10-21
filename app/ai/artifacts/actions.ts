"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";

/** Soft delete: the artifact leaves the gallery, its versions are kept. */
export async function deleteArtifact(id: string) {
  const artifactId = z.uuid().parse(id);
  const { supabase, workspace } = await requireWorkspace();
  const { error } = await supabase.from("artifacts").update({ deleted_at: new Date().toISOString() }).eq("workspace_id", workspace.id).eq("id", artifactId);
  if (error) throw error;
  redirect("/ai/artifacts");
}
