import { financeRoute } from "@/lib/finance-api";
import { createDrizzleCommandRegistry, handleExecuteCommand } from "@/lib/commands";

/**
 * POST /api/v1/commands/{commandName} — run one typed domain command
 * idempotently. Effects, audit rows, and outbox events commit atomically;
 * replays return the stored result verbatim.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ commandName: string }> },
) {
  return financeRoute(async (session) => {
    const { commandName } = await context.params;
    const body: unknown = await request.json().catch(() => null);
    return handleExecuteCommand(commandName, body, {
      workspaceId: session.wid,
      actorUserId: session.uid,
      registry: createDrizzleCommandRegistry(),
    });
  });
}
