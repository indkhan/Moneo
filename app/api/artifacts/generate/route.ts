import { generateText, Output } from "ai";
import { z } from "zod";
import { modelForSettings } from "@/lib/ai/provider";
import { requireWorkspace } from "@/lib/auth";
import { artifactKindSchema } from "@/lib/artifacts/spec";
import { runArtifactGeneration } from "@/lib/artifacts/generation";
import { reportedUsage } from "@/lib/ai/usage";

const artifactKind = artifactKindSchema;

// AI output is bounded: one trusted type plus a concise name and rationale.
// The AI never chooses a workspace and never produces executable source.
const proposalSchema = z.object({
  kind: artifactKind,
  name: z.string().trim().min(1).max(120),
  rationale: z.string().trim().min(1).max(280),
});

const proposeRequestSchema = z.object({
  description: z.string().trim().min(1).max(500),
  requestId: z.uuid().optional(),
}).strict();

const confirmRequestSchema = z.object({
  confirm: z.literal(true),
  kind: artifactKind,
  name: z.string().trim().min(1).max(120),
}).strict();

export async function POST(request: Request) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try {
    context = await requireWorkspace();
  } catch {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);

  // Explicit confirmation step: create only from user-confirmed kind/name
  // via the trusted-template RPC. No workspace, source, or code is accepted.
  const confirmParsed = confirmRequestSchema.safeParse(body);
  if (confirmParsed.success) {
    const { supabase } = context;
    const { kind, name } = confirmParsed.data;
    const { data, error } = await supabase.rpc("create_trusted_artifact", {
      p_kind: kind,
      p_name: name,
    });
    if (error || !(data as { id?: string } | null)) {
      return Response.json(
        { error: error?.message ?? "Artifact creation failed" },
        { status: 500 },
      );
    }
    return Response.json({ id: (data as { id: string }).id });
  }

  const proposeParsed = proposeRequestSchema.safeParse(body);
  if (!proposeParsed.success)
    return Response.json({ error: "Describe a financial tool in 1–500 characters" }, { status: 400 });
  if (!process.env.OPENROUTER_API_KEY)
    return Response.json({ error: "AI is not configured" }, { status: 503 });

  return runArtifactGeneration(context.supabase, request, { requestId: proposeParsed.data.requestId ?? crypto.randomUUID(), purpose: "proposal", description: proposeParsed.data.description }, async () => {
    const model = await modelForSettings(context.settings, { effort: "minimal", exclude: true });
    const generated = await generateText({
      model, output: Output.json(), maxOutputTokens: 800,
      abortSignal: AbortSignal.any([request.signal, AbortSignal.timeout(90_000)]),
      system: `Return only JSON, without Markdown, matching this schema: ${JSON.stringify(z.toJSONSchema(proposalSchema))}`,
      prompt:
        `Pick exactly one trusted financial-tool template for the request below. ` +
        `Allowed kinds: spending_explorer (past spending), trip_planner (one-time trip cost), goal_tracker (savings goals), custom_planner (other financial plans), custom_tracker (tracking measures), custom_report (summaries), custom_comparison (scenario comparisons). ` +
        `Return a concise tool name (1–120 characters) and a one-sentence rationale. ` +
        `Do not choose a workspace. Do not generate code or source.\n` +
        `Request: ${proposeParsed.data.description}`,
    });
    return { result: proposalSchema.strict().parse(JSON.parse(generated.text)), usage: reportedUsage(model.modelId, generated.totalUsage) };
  });
}
