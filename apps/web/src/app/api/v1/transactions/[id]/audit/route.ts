import { getSession } from "@/lib/auth-session";
import { listEntityAudit } from "@moneo/db/audit-history";
import { withWorkspaceTransaction } from "@moneo/db/tenancy";
import { NextResponse } from "next/server";

/** Issue 5.6 — immutable, tenant-scoped transaction history. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session?.wid) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const workspaceId = session.wid;
  const { id } = await params;
  const items = await withWorkspaceTransaction(workspaceId, (tx) =>
    listEntityAudit(tx, workspaceId, "transaction", id),
  );
  return NextResponse.json({
    items: items.map((item) => ({
      ...item,
      actor: item.actorName ?? item.actorEmail ?? "System",
      createdAt: item.createdAt.toISOString(),
    })),
  });
}
