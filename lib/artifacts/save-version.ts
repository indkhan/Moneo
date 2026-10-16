import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ArtifactKind } from "./spec";
import { validateGeneratedCandidate, type ValidationResult } from "./validate";

// The single trusted save boundary for generated, edited and template code.
// Every candidate is re-validated server-side (allowlist, manifest, QuickJS
// smoke incl. missing-data) BEFORE the CAS version RPC. Failed candidates are
// stored with status='failed'; the RPC keeps the prior active version and
// artifact_state untouched.
export async function saveCandidateVersion(args: {
  supabase: SupabaseClient;
  workspaceId: string;
  actorId: string;
  artifact: { id: string; kind: ArtifactKind; permissions: unknown };
  source: string;
  manifest: unknown;
  expectedActiveVersionId: string | null;
}): Promise<
  | { configured: false }
  | { configured: true; validation: ValidationResult; status: "validated" | "failed"; saved: unknown; error: { code?: string; message?: string } | null }
> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return { configured: false };
  const { supabase, workspaceId, artifact } = args;
  const permissions = Array.isArray(artifact.permissions) ? (artifact.permissions as string[]) : [];
  const { data: stateRow } = await supabase.from("artifact_state").select("state")
    .eq("workspace_id", workspaceId).eq("artifact_id", artifact.id).maybeSingle();
  const state = stateRow?.state && typeof stateRow.state === "object" ? (stateRow.state as Record<string, unknown>) : {};

  const validation = await validateGeneratedCandidate({ kind: artifact.kind, source: args.source, manifest: args.manifest, permissions, state });
  const status = validation.ok ? "validated" as const : "failed" as const;

  // This client stays in the server save boundary; generated code never receives it.
  const service = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: saved, error } = await service.rpc("save_validated_generated_artifact_version", {
    p_artifact_id: artifact.id,
    p_actor_id: args.actorId,
    p_source: args.source,
    p_manifest: validation.manifest ?? args.manifest,
    p_status: status,
    p_error: validation.ok ? "" : validation.errors.join("; ").slice(0, 2000),
    p_expected_active_version_id: args.expectedActiveVersionId,
  });
  return { configured: true, validation, status, saved: Array.isArray(saved) ? saved[0] : saved, error };
}
