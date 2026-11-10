import { requireWorkspace } from "@/lib/auth";
import { applicationState } from "@/lib/application";

export async function GET() {
  await requireWorkspace();
  const state = await applicationState(false);
  return Response.json({ tag: state.checkUpdates ? state.release?.tag ?? null : null }, { headers: { "Cache-Control": "no-store" } });
}
