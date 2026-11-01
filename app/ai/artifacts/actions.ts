"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";

/** A new artifact with its own chat; the first request is sent from its page, so the build streams there. */
export async function createArtifact(form: FormData) {
  const prompt = z.string().trim().min(1).max(4000).parse(form.get("prompt"));
  const { supabase, workspace } = await requireWorkspace();
  const title = prompt.split("\n")[0].slice(0, 80).trim() || "New artifact";
  const artifact = await supabase.from("artifacts").insert({ workspace_id: workspace.id, title }).select("id").single();
  if (artifact.error) throw new Error("Could not create the artifact; try again");
  const chat = await supabase.from("conversations").insert({ workspace_id: workspace.id, title, artifact_id: artifact.data.id });
  if (chat.error) throw new Error("Could not create the artifact; try again");
  redirect(`/ai/artifacts/${artifact.data.id}?start=${encodeURIComponent(prompt)}`);
}

/** Soft delete: the artifact leaves the gallery and its cards leave Home; its versions are kept. */
export async function deleteArtifact(id: string) {
  const artifactId = z.uuid().parse(id);
  const { supabase, workspace } = await requireWorkspace();
  const { error } = await supabase.from("artifacts").update({ deleted_at: new Date().toISOString() }).eq("workspace_id", workspace.id).eq("id", artifactId);
  if (error) throw error;
  revalidatePath("/ai/artifacts");
  revalidatePath("/");
  redirect("/ai/artifacts");
}
