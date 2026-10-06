"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { artifactKindSchema, calculatorManifestSchema, normalizeCalculatorParams } from "@/lib/artifacts/spec";

const kind = artifactKindSchema;

export async function createArtifact(form: FormData) {
  const { supabase } = await requireWorkspace();
  const artifactKind = kind.parse(form.get("kind"));
  const name = z.string().trim().min(1).max(120).parse(form.get("name"));
  const { data, error } = await supabase.rpc("create_trusted_artifact", { p_kind: artifactKind, p_name: name });
  if (error || !data) throw error ?? new Error("Artifact creation failed");
  redirect(`/ai/library/${data.id}`);
}

export async function renameArtifact(form: FormData) {
  const { supabase } = await requireWorkspace();
  const artifactId = z.uuid().parse(form.get("artifactId"));
  const name = z.string().trim().min(1).max(120).parse(form.get("name"));
  const { error } = await supabase.rpc("rename_trusted_artifact", { p_artifact_id: artifactId, p_name: name });
  if (error) throw error;
  redirect(`/ai/library/${artifactId}`);
}

export async function pinArtifact(form: FormData) {
  const { supabase, workspace } = await requireWorkspace();
  const artifactId = z.uuid().parse(form.get("artifactId"));
  const { error } = await supabase.from("dashboard_items").upsert({
    workspace_id: workspace.id, artifact_id: artifactId,
  }, { onConflict: "workspace_id,artifact_id" });
  if (error) throw error;
  redirect(`/ai/library/${artifactId}`);
}

export async function unpinArtifact(form: FormData) {
  const { supabase, workspace } = await requireWorkspace();
  const artifactId = z.uuid().parse(form.get("artifactId"));
  const { error } = await supabase.from("dashboard_items").delete()
    .eq("workspace_id", workspace.id).eq("artifact_id", artifactId);
  if (error) throw error;
  redirect(`/ai/library/${artifactId}`);
}

export async function saveCalculatorParams(form: FormData) {
  const { supabase, workspace } = await requireWorkspace();
  const artifactId = z.uuid().parse(form.get("artifactId"));
  const raw = z.string().max(2000).parse(form.get("params"));
  let parsed: Record<string, unknown>;
  try {
    parsed = z.record(z.string(), z.union([z.number(), z.string()])).parse(JSON.parse(raw));
  } catch {
    throw new Error("Params must be JSON object of numbers/strings");
  }
  const { data: artifact } = await supabase.from("artifacts").select("id, active_version_id")
    .eq("workspace_id", workspace.id).eq("id", artifactId).single();
  if (!artifact?.active_version_id) throw new Error("Artifact not found");
  const { data: version } = await supabase.from("artifact_versions").select("manifest")
    .eq("workspace_id", workspace.id).eq("id", artifact.active_version_id).single();
  const manifest = calculatorManifestSchema.parse(version?.manifest);
  const next = normalizeCalculatorParams(manifest, parsed);
  const { data: current, error: readError } = await supabase.from("artifact_state").select("state, version")
    .eq("workspace_id", workspace.id).eq("artifact_id", artifactId).single();
  if (readError || !current) throw readError ?? new Error("Artifact state unavailable");
  const merged = { ...((current.state as Record<string, unknown>) ?? {}), ...next };
  const { data: saved, error } = await supabase.from("artifact_state").update({
    state: merged, version: current.version + 1, updated_at: new Date().toISOString(),
  }).eq("workspace_id", workspace.id).eq("artifact_id", artifactId).eq("version", current.version)
    .select("version").maybeSingle();
  if (error) throw error;
  if (!saved) throw new Error("Artifact changed; refresh and retry");
  redirect(`/ai/library/${artifactId}`);
}

export async function saveTripState(form: FormData) {
  const { supabase, workspace } = await requireWorkspace();
  const artifactId = z.uuid().parse(form.get("artifactId"));
  const cost = z.coerce.number().int().min(0).max(10_000_000).parse(form.get("costMinor"));
  const { data: artifact } = await supabase.from("artifacts").select("kind")
    .eq("workspace_id", workspace.id).eq("id", artifactId).single();
  if (artifact?.kind !== "trip_planner") throw new Error("Trip planner not found");
  const { data: current, error: readError } = await supabase.from("artifact_state").select("version")
    .eq("workspace_id", workspace.id).eq("artifact_id", artifactId).single();
  if (readError || !current) throw readError ?? new Error("Artifact state unavailable");
  const { data: saved, error } = await supabase.from("artifact_state").update({
    state: { costMinor: cost }, version: current.version + 1, updated_at: new Date().toISOString(),
  }).eq("workspace_id", workspace.id).eq("artifact_id", artifactId).eq("version", current.version)
    .select("version").maybeSingle();
  if (error) throw error;
  if (!saved) throw new Error("Artifact changed; refresh and retry");
  redirect(`/ai/library/${artifactId}`);
}
