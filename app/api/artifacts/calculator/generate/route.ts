import { generateObject } from "ai";
import { z } from "zod";
import { getModel } from "@/lib/ai/provider";
import { requireWorkspace } from "@/lib/auth";
import { ALLOWED_SDK_BY_KIND, artifactKindSchema } from "@/lib/artifacts/spec";
import { validateGeneratedCandidate } from "@/lib/artifacts/validate";

// AI drafts a tiny declarative calculator only. It never touches finance
// data, workspaces, or executable permissions: the model receives the
// artifact kind, allowed SDK names, and the user's short description, and
// returns source + manifest. The server validates (allowlist, manifest,
// QuickJS smoke incl. missing-data) before the UI may save it.
const requestSchema = z
  .object({
    artifactId: z.uuid(),
    description: z.string().trim().min(1).max(500),
  })
  .strict();

const aiOutputSchema = z.object({
  source: z.string().min(1).max(8000),
  manifest: z.object({
    kind: artifactKindSchema,
    runtime: z.literal("quickjs-calculator-v1"),
    sdk: z.array(z.string().min(1).max(40)).max(6),
    params: z
      .record(
        z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/),
        z.object({
          type: z.enum(["number", "string"]),
          default: z.union([z.number(), z.string()]),
          min: z.number().optional(),
          max: z.number().optional(),
          maxLength: z.number().int().min(1).max(200).optional(),
          label: z.string().max(80).optional(),
        }),
      )
      .default({}),
    renderer: z.literal("trusted").default("trusted"),
  }),
  rationale: z.string().trim().min(1).max(280),
});

export async function POST(request: Request) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try {
    context = await requireWorkspace();
  } catch {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Provide artifactId and a 1–500 character description" },
      { status: 400 },
    );
  }
  const { supabase, workspace } = context;
  const { data: artifact, error } = await supabase
    .from("artifacts")
    .select("id, kind, permissions")
    .eq("workspace_id", workspace.id)
    .eq("id", parsed.data.artifactId)
    .maybeSingle();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!artifact) return Response.json({ error: "Artifact not found" }, { status: 404 });
  const kind = artifactKindSchema.safeParse(artifact.kind);
  if (!kind.success) return Response.json({ error: "Unsupported artifact kind" }, { status: 400 });
  const permissions = Array.isArray(artifact.permissions) ? (artifact.permissions as string[]) : [];

  if (!process.env.OPENROUTER_API_KEY) {
    return Response.json({ error: "AI is not configured" }, { status: 503 });
  }

  const allowedSdk = [...new Set([...(ALLOWED_SDK_BY_KIND[kind.data] ?? []), ...permissions])];
  try {
    const { object } = await generateObject({
      model: getModel(),
      schema: aiOutputSchema,
      prompt:
        `Write the smallest safe financial calculator for a ${kind.data} tool. ` +
        `Output a pure function expression like (input) => ({...}) plus a manifest and one-sentence rationale. ` +
        `Rules: read ONLY input.snapshot and input.params; never use window, document, cookies, storage, fetch, network, eval, Function, import, require, React, DOM, database, tokens, or SDK handles. ` +
        `Keep output a small JSON object with one of summary/rows/numbers/chart/unavailable/warning (no HTML, no scripts). ` +
        `Handle missing data by returning { unavailable: "..." } instead of throwing. ` +
        `Manifest kind must be ${kind.data}, runtime quickjs-calculator-v1, sdk a subset of [${allowedSdk.join(", ")}], params only artifact-local numbers/strings. ` +
        `Snapshot shapes: spending_explorer {currency,incomeMinor,spendingMinor,netMinor,daily[{date,spendingMinor}],unavailable?}; ` +
        `trip_planner {currency,baselineAvailableMinor,tripDate,unavailable?} params {costMinor}; ` +
        `goal_tracker {currency,goals[{id,name,targetMinor,savedMinor,remainingMinor}],unavailable?} params {extraMonthlyMinor}. ` +
        `Request: ${parsed.data.description}`,
    });
    const validation = await validateGeneratedCandidate({
      kind: kind.data,
      source: object.source,
      manifest: object.manifest,
      permissions,
    });
    return Response.json({
      source: object.source,
      manifest: object.manifest,
      rationale: object.rationale,
      validation:
        validation.ok
          ? { ok: true as const, warnings: validation.warnings }
          : { ok: false as const, errors: validation.errors },
    });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : "AI request failed" },
      { status: 502 },
    );
  }
}
