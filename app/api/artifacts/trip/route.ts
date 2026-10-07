import { z } from "zod";
import { requireWorkspace } from "@/lib/auth";
import { buildCalculatorSnapshot } from "@/lib/artifacts/snapshot";
import { artifactKindSchema, calculatorManifestSchema, normalizeCalculatorParams } from "@/lib/artifacts/spec";
import { assertTripCostCurrency } from "@/lib/artifacts/trip-params";
import { tripCostMinor, tripScenarioSchema } from "@/lib/finance/trip-scenario";

export async function POST(request: Request) {
  try {
    const { supabase, workspace } = await requireWorkspace();
    const body = await request.text();
    if (body.length > 16000) return Response.json({ error: "Trip inputs too large" }, { status: 413 });
    const args = z.union([
      z.object({ artifactId: z.uuid(), scenario: tripScenarioSchema }).strict(),
      z.object({ artifactId: z.uuid(), params: z.record(z.string(), z.union([z.string().max(200), z.number().finite()])), baseScenario: tripScenarioSchema.optional() }).strict(),
    ]).parse(JSON.parse(body));
    const { data: artifact, error } = await supabase.from("artifacts").select("kind, active_version_id")
      .eq("workspace_id", workspace.id).eq("id", args.artifactId).maybeSingle();
    if (error || !artifact?.active_version_id) return Response.json({ error: "Tool unavailable" }, { status: 404 });
    const kind = artifactKindSchema.parse(artifact.kind);
    let scenario = "scenario" in args ? args.scenario : undefined;
    let costMinor = 0n;
    let sdk: string[] = ["forecast"];
    let investigation: import("@/lib/finance/investigation").InvestigationSpec | undefined;
    let month: string | undefined;
    let reportingView: "original" | "base" | undefined;
    let tripParams: Record<string, string | number> | undefined;
    if ("scenario" in args) {
      if (kind !== "trip_planner") throw new Error("Trip inputs require a trip planner");
    } else {
      const [{ data: version }, { data: saved }] = await Promise.all([
        supabase.from("artifact_versions").select("manifest").eq("workspace_id", workspace.id).eq("id", artifact.active_version_id).maybeSingle(),
        supabase.from("artifact_state").select("state").eq("workspace_id", workspace.id).eq("artifact_id", args.artifactId).maybeSingle(),
      ]);
      const manifest = calculatorManifestSchema.parse(version?.manifest);
      if (manifest.kind !== kind || !manifest.sdk.includes("forecast")) throw new Error("Forecast permission is not declared");
      if (Object.keys(args.params).some(key => !(key in manifest.params))) throw new Error("Undeclared trip parameter");
      assertTripCostCurrency(manifest.params.costMinor?.currency, workspace.display_currency);
      const params = normalizeCalculatorParams(manifest, args.params);
      tripParams = params;
      sdk = manifest.sdk; investigation = manifest.investigation;
      month = typeof params.month === "string" ? params.month : undefined;
      reportingView = z.enum(["original", "base"]).optional().parse(params.reportingView);
      costMinor = BigInt(z.string().regex(/^\d{1,18}$/).parse(String(params.costMinor ?? 0)));
      const state = (saved?.state ?? {}) as Record<string, unknown>;
      scenario = args.baseScenario ?? (state.tripScenario === undefined ? undefined : tripScenarioSchema.parse(state.tripScenario));
    }
    if (scenario) costMinor = tripCostMinor(scenario, workspace.display_currency) ?? 0n;
    const result = await buildCalculatorSnapshot(args.artifactId, kind, { costMinor, tripScenario: scenario, tripParams, sdk, investigation, month, reportingView });
    return Response.json(result.snapshot, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Trip preview unavailable";
    const status = message === "Unauthorized" ? 401 : error instanceof z.ZodError || error instanceof SyntaxError || /permission|parameter|inputs|past|horizon|multiple|Unknown|Trip cost currency/.test(message) ? 400 : 503;
    return Response.json({ error: status === 503 ? "Trip preview unavailable; try again" : message }, { status });
  }
}
