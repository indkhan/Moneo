"use server";

import { safely, type SafeState } from "@/lib/safe-action";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { modelIdSchema } from "@/lib/ai/model-id";

export async function createArtifact(form: FormData) {
  const prompt = z.string().trim().min(1).max(4000).parse(form.get("prompt"));
  const model = modelIdSchema.optional().parse(form.get("model") || undefined);
  const { supabase, workspace } = await requireWorkspace();
  const title = prompt.split("\n")[0].slice(0, 80).trim() || "New artifact";
  const artifact = await supabase.from("artifacts").insert({ workspace_id: workspace.id, title, first_prompt: prompt }).select("id").single();
  if (artifact.error) throw new Error("Could not create the artifact; try again");
  const chat = await supabase.from("conversations").insert({ workspace_id: workspace.id, title, artifact_id: artifact.data.id, ...model && { model } });
  if (chat.error) throw new Error("Could not create the artifact; try again");
  redirect(`/ai/artifacts/${artifact.data.id}`);
}

export async function claimFirstPrompt(id: string) {
  const artifactId = z.uuid().parse(id);
  const { supabase, workspace } = await requireWorkspace();
  const { data, error } = await supabase.from("artifacts").update({ first_prompt_claimed_at: new Date().toISOString() })
    .eq("workspace_id", workspace.id).eq("id", artifactId).is("first_prompt_claimed_at", null).not("first_prompt", "is", null).select("first_prompt").maybeSingle();
  if (error) throw error;
  return (data?.first_prompt as string | undefined) ?? null;
}

export async function deleteArtifact(id: string) {
  const artifactId = z.uuid().parse(id);
  const { supabase, workspace } = await requireWorkspace();
  const { error } = await supabase.from("artifacts").update({ deleted_at: new Date().toISOString() }).eq("workspace_id", workspace.id).eq("id", artifactId);
  if (error) throw error;
  revalidatePath("/ai/artifacts");
  revalidatePath("/");
  redirect("/ai/artifacts");
}

export async function renameArtifact(form: FormData) {
  const { id, title } = z.object({ id: z.uuid(), title: z.string().trim().min(1, "Enter a name").max(120) }).parse({ id: form.get("id"), title: form.get("title") });
  const { supabase, workspace } = await requireWorkspace();
  const { error } = await supabase.from("artifacts").update({ title }).eq("workspace_id", workspace.id).eq("id", id).is("deleted_at", null);
  if (error) throw new Error("Could not rename the artifact; try again");
  revalidatePath(`/ai/artifacts/${id}`);
  revalidatePath("/ai/artifacts");
}

export async function renameArtifactSafely(_state: SafeState, form: FormData) { return safely(form, renameArtifact); }

export async function createArtifactSafely(_state: SafeState, form: FormData) { return safely(form, createArtifact); }
