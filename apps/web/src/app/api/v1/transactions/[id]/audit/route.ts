import { financeRoute } from "@/lib/finance-api";
import { listEntityAudit } from "@moneo/db/audit-history";
import { withWorkspaceTransaction } from "@moneo/db/tenancy";
import { NextResponse } from "next/server";

/** Issue 5.6 — immutable, tenant-scoped transaction history. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return financeRoute(async (session) => {
    const { id } = await params;
    const items = await withWorkspaceTransaction(session.wid, (tx) =>
      listEntityAudit(tx, session.wid, "transaction", id),
    );
    return NextResponse.json({
      items: items.map((item) => ({
        ...item,
        actor: item.actorName ?? item.actorEmail ?? "System",
        createdAt: item.createdAt.toISOString(),
      })),
    });
  });
}
