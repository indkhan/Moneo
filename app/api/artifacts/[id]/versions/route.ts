import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { artifactKindSchema } from "@/lib/artifacts/spec";
import { validateGeneratedCandidate } from "@/lib/artifacts/validate";

const saveSchema = z
  .object({
    source: z.string().min(1).max(8000),
    manifest: z.unknown(),
    expectedActiveVersionId: z.uuid().nullable(),
  })
  .strict();
const restoreSchema = z.object({ restoreTrustedVersionId: z.uuid(), expectedActiveVersionId: z.uuid().nullable() }).strict();

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try {
    context = await requireWorkspace();
  } catch {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const rawCursor = new URL(request.url).searchParams.get("before");
  const cursor = rawCursor === null ? null : z.coerce.number().int().min(1).max(2147483647).safeParse(rawCursor);
  if (cursor && !cursor.success) return Response.json({ error: "Invalid history cursor" }, { status: 400 });
  if (!z.uuid().safeParse(id).success) {
    return Response.json({ error: "Invalid artifact id" }, { status: 400 });
  }
  const { supabase, workspace } = context;
  const { data: artifact, error: artifactError } = await supabase
    .from("artifacts")
    .select("id, active_version_id")
    .eq("workspace_id", workspace.id)
    .eq("id", id)
    .maybeSingle();
  if (artifactError) return Response.json({ error: artifactError.message }, { status: 500 });
  if (!artifact) return Response.json({ error: "Artifact not found" }, { status: 404 });
  let query = supabase
    .from("artifact_versions")
    .select("id, version, status, error, created_at, manifest, source")
    .eq("workspace_id", workspace.id)
    .eq("artifact_id", id)
    .order("version", { ascending: false });
  if (cursor?.success) query = query.lt("version", cursor.data);
  const { data, error } = await query.limit(21);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  const versions = (data ?? []).slice(0, 20);
  return Response.json({ activeVersionId: artifact.active_version_id, versions,
    nextCursor: (data?.length ?? 0) > 20 ? versions.at(-1)?.version : null });
}

// Every candidate is re-validated server-side (allowlist, manifest,
// QuickJS smoke incl. missing-data, resource checks) BEFORE the version
// RPC. Failed candidates are stored with status='failed' and the RPC keeps
// the prior active version and artifact_state untouched.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try {
    context = await requireWorkspace();
  } catch {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) {
    return Response.json({ error: "Invalid artifact id" }, { status: 400 });
  }
  const body = await request.json().catch(() => null);
  const parsed = z.union([saveSchema, restoreSchema]).safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Provide source (1–8000 chars) and manifest" }, { status: 400 });
  }
  const { supabase, workspace } = context;
  const { data: artifact, error: artifactError } = await supabase
    .from("artifacts")
    .select("id, kind, permissions, active_version_id")
    .eq("workspace_id", workspace.id)
    .eq("id", id)
    .maybeSingle();
  if (artifactError) return Response.json({ error: artifactError.message }, { status: 500 });
  if (!artifact) return Response.json({ error: "Artifact not found" }, { status: 404 });
  const kind = artifactKindSchema.safeParse(artifact.kind);
  if (!kind.success) return Response.json({ error: "Unsupported artifact kind" }, { status: 400 });
  async function failedSave(error: { code?: string; message?: string } | null) {
    if (error?.code === "40001") {
      const { data: current } = await supabase.from("artifacts").select("active_version_id")
        .eq("workspace_id", workspace.id).eq("id", id).maybeSingle();
      return Response.json({ error: "Active version changed. Your local work is preserved; reload the current version or review it before explicitly replacing it.", activeVersionId: current?.active_version_id ?? null }, { status: 409 });
    }
    return Response.json({ error: error?.message ?? "Version save failed" }, { status: error?.code === "P0002" ? 404 : error?.code === "42501" ? 403 : 500 });
  }
  if ("restoreTrustedVersionId" in parsed.data) {
    // No client source/manifest/status can enter this constrained builtin restore.
    const { data: saved, error } = await supabase.rpc("restore_trusted_artifact_version", {
      p_artifact_id: id, p_version_id: parsed.data.restoreTrustedVersionId,
      p_expected_active_version_id: parsed.data.expectedActiveVersionId,
    });
    if (error || !saved) return failedSave(error);
    return Response.json({ version: Array.isArray(saved) ? saved[0] : saved, status: "validated" });
  }
  const permissions = Array.isArray(artifact.permissions) ? (artifact.permissions as string[]) : [];

  const { data: stateRow } = await supabase
    .from("artifact_state")
    .select("state")
    .eq("workspace_id", workspace.id)
    .eq("artifact_id", id)
    .maybeSingle();
  const state =
    stateRow?.state && typeof stateRow.state === "object"
      ? (stateRow.state as Record<string, unknown>)
      : {};

  const validation = await validateGeneratedCandidate({
    kind: kind.data,
    source: parsed.data.source,
    manifest: parsed.data.manifest,
    permissions,
    state,
  });

  const status = validation.ok ? "validated" : "failed";
  const errorText = validation.ok ? "" : validation.errors.join("; ").slice(0, 2000);
  const manifestToStore = validation.manifest ?? parsed.data.manifest;

  const { data: saved, error: saveError } = await supabase.rpc(
    "save_generated_artifact_version",
    {
      p_artifact_id: id,
      p_source: parsed.data.source,
      p_manifest: manifestToStore,
      p_status: status,
      p_error: errorText,
      p_expected_active_version_id: parsed.data.expectedActiveVersionId,
    },
  );
  if (saveError || !saved) {
    return failedSave(saveError);
  }
  const row = Array.isArray(saved) ? saved[0] : saved;
  return Response.json({
    version: row,
    status,
    activeVersionPreserved: !validation.ok
      ? (artifact.active_version_id ?? null)
      : null,
    validation: validation.ok
      ? { ok: true as const, warnings: validation.warnings }
      : { ok: false as const, errors: validation.errors },
  });
}
