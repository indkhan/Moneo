"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { artifactKindSchema, calculatorManifestSchema, normalizeCalculatorParams } from "@/lib/artifacts/spec";
import { tripHorizon, tripScenarioSchema, type TripScenario } from "@/lib/finance/trip-scenario";
import { calendarDate } from "@/lib/finance/calendar";
import { tripScenarioForParams, tripStateForScenario } from "@/lib/artifacts/trip-params";
import { tripForArtifact } from "@/lib/artifacts/finance-sdk";

const kind = artifactKindSchema;
const stateRevision = z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(0).max(2147483646));

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
  const expectedActiveVersionId = z.uuid().parse(form.get("expectedActiveVersionId"));
  const { error } = await supabase.rpc("rename_trusted_artifact", { p_artifact_id: artifactId, p_name: name, p_expected_active_version_id: expectedActiveVersionId });
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
  const expectedVersion = stateRevision.parse(form.get("expectedVersion"));
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
  if (current.version !== expectedVersion) return { conflict: true } as const;
  const merged = { ...((current.state as Record<string, unknown>) ?? {}), ...next };
  if (manifest.sdk.includes("forecast") && next.accountId !== undefined) z.string().min(1).max(100).parse(next.accountId);
  if (manifest.sdk.includes("forecast") && ["costMinor", "tripDate", "accountId"].some(key => key in next)) {
    const existing = merged.tripScenario === undefined
      ? (await tripForArtifact(artifactId, BigInt(String(next.costMinor ?? (typeof merged.costMinor === "number" && Number.isSafeInteger(merged.costMinor) && merged.costMinor >= 0 ? merged.costMinor : 90000))), typeof next.accountId === "string" && next.accountId ? next.accountId : undefined)).scenario
      : tripScenarioSchema.parse(merged.tripScenario);
    merged.tripScenario = tripScenarioForParams(existing, next, workspace.display_currency);
    tripHorizon(calendarDate(new Date(), workspace.timezone), merged.tripScenario);
  }
  if (merged.tripScenario !== undefined) await validateTripAccounts(supabase, workspace.id, tripScenarioSchema.parse(merged.tripScenario));
  const { data: saved, error } = await supabase.from("artifact_state").update({
    state: merged, version: expectedVersion + 1, updated_at: new Date().toISOString(),
  }).eq("workspace_id", workspace.id).eq("artifact_id", artifactId).eq("version", expectedVersion)
    .select("version").maybeSingle();
  if (error) throw error;
  if (!saved) return { conflict: true } as const;
  return { saved: true, version: saved.version as number, value: next } as const;
}

export async function saveTripState(form: FormData) {
  const { supabase, workspace } = await requireWorkspace();
  const artifactId = z.uuid().parse(form.get("artifactId"));
  const expectedVersion = stateRevision.parse(form.get("expectedVersion"));
  const cost = z.coerce.number().int().min(0).max(10_000_000).parse(form.get("costMinor"));
  const { data: artifact } = await supabase.from("artifacts").select("kind")
    .eq("workspace_id", workspace.id).eq("id", artifactId).single();
  if (artifact?.kind !== "trip_planner") throw new Error("Trip planner not found");
  const { data: current, error: readError } = await supabase.from("artifact_state").select("version")
    .eq("workspace_id", workspace.id).eq("artifact_id", artifactId).single();
  if (readError || !current) throw readError ?? new Error("Artifact state unavailable");
  if (current.version !== expectedVersion) return { conflict: true } as const;
  const { data: saved, error } = await supabase.from("artifact_state").update({
    state: { costMinor: cost }, version: expectedVersion + 1, updated_at: new Date().toISOString(),
  }).eq("workspace_id", workspace.id).eq("artifact_id", artifactId).eq("version", expectedVersion)
    .select("version").maybeSingle();
  if (error) throw error;
  if (!saved) return { conflict: true } as const;
  return { saved: true, version: saved.version as number, value: String(cost) } as const;
}

export async function saveDatedTripState(form: FormData) {
  const { supabase, workspace } = await requireWorkspace();
  const artifactId = z.uuid().parse(form.get("artifactId"));
  const expectedVersion = stateRevision.parse(form.get("expectedVersion"));
  const scenario = tripScenarioSchema.parse(JSON.parse(z.string().max(16000).parse(form.get("scenario"))));
  tripHorizon(calendarDate(new Date(), workspace.timezone), scenario);
  const { data: artifact } = await supabase.from("artifacts").select("kind").eq("workspace_id", workspace.id).eq("id", artifactId).single();
  if (artifact?.kind !== "trip_planner") throw new Error("Trip planner not found");
  const { data: current, error: readError } = await supabase.from("artifact_state").select("state, version")
    .eq("workspace_id", workspace.id).eq("artifact_id", artifactId).single();
  if (readError || !current) throw readError ?? new Error("Artifact state unavailable");
  if (current.version !== expectedVersion) return { conflict: true } as const;
  await validateTripAccounts(supabase, workspace.id, scenario);
  const next = tripStateForScenario((current.state as Record<string, unknown>) ?? {}, scenario, workspace.display_currency);
  const { data: saved, error } = await supabase.from("artifact_state").update({
    state: next, version: expectedVersion + 1, updated_at: new Date().toISOString(),
  }).eq("workspace_id", workspace.id).eq("artifact_id", artifactId).eq("version", expectedVersion).select("version").maybeSingle();
  if (error) throw error;
  if (!saved) return { conflict: true } as const;
  return { saved: true, version: saved.version as number, value: scenario } as const;
}

async function validateTripAccounts(supabase: Awaited<ReturnType<typeof requireWorkspace>>["supabase"], workspaceId: string, scenario: TripScenario) {
  const accountIds = [...new Set(scenario.payments.map(item => item.accountId))];
  const { data: accounts, error: accountsError } = await supabase.from("accounts").select("id").eq("workspace_id", workspaceId).is("archived_at", null).in("id", accountIds);
  if (accountsError) throw accountsError;
  if (accountIds.some(id => !accounts?.some(account => account.id === id))) throw new Error("Unknown paying or receiving account");
}
