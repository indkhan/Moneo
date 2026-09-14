import { financeRoute } from "@/lib/finance-api";
import { createTransactionView, listTransactionViews } from "@moneo/db/transaction-views";
import { withWorkspaceTransaction } from "@moneo/db/tenancy";
import { NextResponse } from "next/server";
import { transactionViewDefinitionSchema } from "@/lib/contract";

export async function GET() {
  return financeRoute(async (session) => {
    const workspaceId = session.wid;
    const items = await withWorkspaceTransaction(workspaceId, (tx) =>
      listTransactionViews(tx, workspaceId),
    );
    return NextResponse.json({ items });
  });
}

export async function POST(request: Request) {
  return financeRoute(async (session) => {
    const body = (await request.json()) as { name?: unknown; definition?: unknown };
    if (
      typeof body.name !== "string" ||
      !body.name.trim() ||
      body.name.length > 120 ||
      !body.definition ||
      typeof body.definition !== "object" ||
      Array.isArray(body.definition)
    )
      return NextResponse.json({ error: "invalid view" }, { status: 400 });
    const definition = transactionViewDefinitionSchema.safeParse(body.definition);
    if (!definition.success) return NextResponse.json({ error: "invalid view" }, { status: 400 });
    const name = body.name.trim();
    const workspaceId = session.wid;
    const rows = await withWorkspaceTransaction(workspaceId, (tx) =>
      createTransactionView(tx, workspaceId, name, definition.data),
    );
    return NextResponse.json(rows[0], { status: 201 });
  });
}
