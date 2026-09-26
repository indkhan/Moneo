import { generateObject } from "ai";
import { z } from "zod";
import { getModel } from "@/lib/ai/provider";
import { requireWorkspace } from "@/lib/auth";

const artifactKind = z.enum(["spending_explorer", "trip_planner", "goal_tracker"]);

// AI output is bounded: one trusted type plus a concise name and rationale.
// The AI never chooses a workspace and never produces executable source.
const proposalSchema = z.object({
  kind: artifactKind,
  name: z.string().trim().min(1).max(120),
  rationale: z.string().trim().min(1).max(280),
});

const proposeRequestSchema = z.object({
  description: z.string().trim().min(1).max(500),
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

  try {
    const { object } = await generateObject({
      model: getModel(),
      schema: proposalSchema,
      prompt:
        `Pick exactly one trusted financial-tool template for the request below. ` +
        `Allowed kinds: spending_explorer (past spending), trip_planner (one-time trip cost), goal_tracker (savings goals). ` +
        `Return a concise tool name (1–120 characters) and a one-sentence rationale. ` +
        `Do not choose a workspace. Do not generate code or source.\n` +
        `Request: ${proposeParsed.data.description}`,
    });
    return Response.json(object);
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "AI request failed" },
      { status: 502 },
    );
  }
}
