import { NextResponse } from "next/server";
import { requireWorkspace } from "@/lib/auth";
import { serviceDb } from "@/lib/bank/server";

type UndoPreview = {
  import_id: string;
  filename: string;
  status: string;
  total_rows: number;
  new_rows: number;
  matched_rows: number;
  review_rows: number;
  rejected_rows: number;
  deletable_transactions: number;
  deletable_balances: number;
  blockers: string[];
  safe: boolean;
};

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try {
    context = await requireWorkspace();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const result = await context.supabase.rpc("preview_import_undo", { p_import_id: id });
  if (result.error) return NextResponse.json({ error: result.error.message }, { status: 400 });
  return NextResponse.json(result.data as UndoPreview);
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try {
    context = await requireWorkspace();
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Confirmation with counts is required" }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Confirm undo with current preview counts" }, { status: 400 });
  }
  const input = body as { confirm?: unknown; expectedTransactions?: unknown; expectedBalances?: unknown };
  if (
    input.confirm !== true ||
    typeof input.expectedTransactions !== "number" ||
    !Number.isInteger(input.expectedTransactions) ||
    input.expectedTransactions < 0 ||
    typeof input.expectedBalances !== "number" ||
    !Number.isInteger(input.expectedBalances) ||
    input.expectedBalances < 0
  ) {
    return NextResponse.json({ error: "Confirm undo with current preview counts" }, { status: 400 });
  }
  const result = await context.supabase.rpc("undo_import", {
    p_import_id: id,
    p_expected_transactions: input.expectedTransactions,
    p_expected_balances: input.expectedBalances,
  });
  if (result.error) return NextResponse.json({ error: result.error.message }, { status: 400 });
  await resetBankSyncWindow(context, id);
  return NextResponse.json(result.data);
}

// A bank sync only re-fetches a week before its cursor. Once its rows are undone, the cursor would
// skip them forever, so the next sync starts from the full window again; bank ids dedupe what remains.
async function resetBankSyncWindow(context: Awaited<ReturnType<typeof requireWorkspace>>, importId: string) {
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) return;
  const imported = await context.supabase.from("imports").select("mapping").eq("id", importId).eq("workspace_id", context.workspace.id).maybeSingle();
  const accountName = (imported.data?.mapping as { accountName?: unknown } | null)?.accountName;
  if (typeof accountName !== "string") return;
  await serviceDb().from("bank_connection_accounts").update({ last_booked_on: null })
    .eq("workspace_id", context.workspace.id).eq("account_name", accountName);
}
