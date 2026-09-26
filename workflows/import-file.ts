"use workflow";

import { createHash } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { start } from "workflow/api";
import { decideImportMatch } from "@/lib/import-match";
import { mapRows, parseCsv, parseExcel, type MappedRow } from "@/lib/csv";
import { getModel } from "@/lib/ai/provider";
import { financialReview } from "./financial-review";

// Stable IDs make every canonical effect safe to retry after a partial workflow failure.
function stableId(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function checked<T>(result: { data: T | null; error: { message: string } | null }): T | null {
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

export async function importFile(importId: string, workspaceId: string, rowCount: number) {
  "use workflow";
  try {
    let newRows = 0, matchedRows = 0, reviewRows = 0;
    for (let offset = 0; offset < rowCount; offset += 250) {
      const counts = await processImport(importId, workspaceId, offset, Math.min(offset + 250, rowCount), { newRows, matchedRows, reviewRows });
      newRows = counts.newRows;
      matchedRows = counts.matchedRows;
      reviewRows = counts.reviewRows;
    }
    await finishImport(importId, workspaceId, { newRows, matchedRows, reviewRows });
  } catch (error) {
    await failImport(importId, workspaceId, String(error));
    return;
  }
  await maybeStartFirstReview(importId, workspaceId);
}

async function processImport(importId: string, workspaceId: string, from: number, to: number, prior: { newRows: number; matchedRows: number; reviewRows: number }) {
  "use step";
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase import service is not configured");
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const imported = checked(await db.from("imports").select("*").eq("id", importId).eq("workspace_id", workspaceId).single()) as { status: string; storage_path: string; mapping: unknown };
  if (imported.status === "completed") return prior;
  checked(await db.from("imports").update({ status: "running", error: null }).eq("id", importId).eq("workspace_id", workspaceId).in("status", ["queued", "running"]));
  const blob = checked(await db.storage.from("imports").download(imported.storage_path));
    if (!blob) throw new Error("Stored import file is missing");
    const extension = imported.storage_path.split(".").pop();
    const rows = extension === "csv" ? parseCsv(await blob.text()) : await parseExcel(await blob.arrayBuffer());
    const mapped = mapRows(rows, imported.mapping);
    const mapping = imported.mapping as { accountName: string; currencyCode: string };
    const existingAccount = checked(await db.from("accounts").select("id").eq("workspace_id", workspaceId).eq("name", mapping.accountName).eq("currency_code", mapping.currencyCode).limit(1))!;
    const accountId = existingAccount[0]?.id ?? stableId(`${workspaceId}:account:${mapping.accountName}:${mapping.currencyCode}`);
    if (!existingAccount.length) checked(await db.from("accounts").upsert({ id: accountId, workspace_id: workspaceId, name: mapping.accountName, currency_code: mapping.currencyCode }, { onConflict: "id", ignoreDuplicates: true }));
    const sourceId = stableId(`${workspaceId}:source:${accountId}`);
    checked(await db.from("data_sources").upsert({ id: sourceId, workspace_id: workspaceId, account_id: accountId, kind: "file", name: mapping.accountName }, { onConflict: "id", ignoreDuplicates: true }));
    checked(await db.from("imports").update({ source_id: sourceId, total_rows: mapped.length }).eq("id", importId).eq("workspace_id", workspaceId));

    let { newRows, matchedRows, reviewRows } = prior;
    for (const row of mapped.slice(from, to)) {
      const status = await importRow(db, workspaceId, importId, accountId, row);
      if (status === "new") newRows++;
      else if (status === "matched") matchedRows++;
      else if (status === "review") reviewRows++;
    }
    checked(await db.from("imports").update({ new_rows: newRows, matched_rows: matchedRows, review_rows: reviewRows }).eq("id", importId).eq("workspace_id", workspaceId));
    return { newRows, matchedRows, reviewRows };
}

async function finishImport(importId: string, workspaceId: string, counts: { newRows: number; matchedRows: number; reviewRows: number }) {
  "use step";
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  checked(await db.from("imports").update({ status: "completed", new_rows: counts.newRows, matched_rows: counts.matchedRows, review_rows: counts.reviewRows, error: null }).eq("id", importId).eq("workspace_id", workspaceId).eq("status", "running"));
}

async function failImport(importId: string, workspaceId: string, error: string) {
  "use step";
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  checked(await db.from("imports").update({ status: "failed", error }).eq("id", importId).eq("workspace_id", workspaceId).in("status", ["queued", "running"]));
}

async function maybeStartFirstReview(importId: string, workspaceId: string) {
  "use step";
  if (!process.env.OPENROUTER_API_KEY || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL) return;
  try { getModel(); } catch { return; } // Only a configured free model may start automatically.
  try {
    const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const first = await db.from("imports").select("id").eq("workspace_id", workspaceId).eq("status", "completed").gt("new_rows", 0).order("created_at").order("id").limit(1).maybeSingle();
    if (first.error || first.data?.id !== importId) return;
    const jobId = stableId(`${workspaceId}:first-financial-review`);
    const inserted = await db.from("background_jobs").upsert({ id: jobId, workspace_id: workspaceId, kind: "financial_review" }, { onConflict: "id", ignoreDuplicates: true }).select("id").maybeSingle();
    if (inserted.error || !inserted.data) return; // Another import already owns the first review.
    try {
    await start(financialReview, [jobId, workspaceId]);
    } catch (error) {
      await db.from("background_jobs").update({ status: "failed", stage: "starting", error: String(error) }).eq("id", jobId).eq("workspace_id", workspaceId);
    }
  } catch { /* Analysis is optional; the completed import remains valid. */ }
}

type Db = SupabaseClient<any>;

async function importRow(db: Db, workspaceId: string, importId: string, accountId: string, row: MappedRow): Promise<"new" | "matched" | "review" | "rejected"> {
  const sourceId = stableId(`${importId}:row:${row.rowNumber}`);
  checked(await db.from("source_transactions").upsert({ id: sourceId, workspace_id: workspaceId, import_id: importId, row_number: row.rowNumber, original_row: row.sourceRow, external_id: row.externalId ?? null }, { onConflict: "id", ignoreDuplicates: true }));
  const source = checked(await db.from("source_transactions").select("status").eq("id", sourceId).single()) as { status: string };
  if (source.status === "review") return "review";
  if (source.status === "rejected") return "rejected";
  const linkResult = await db.from("transaction_sources").select("transaction_id").eq("source_transaction_id", sourceId).maybeSingle();
  if (linkResult.error) throw linkResult.error;
  const linked = linkResult.data as { transaction_id: string } | null;
  if (linked) return linked.transaction_id === stableId(`${importId}:transaction:${row.rowNumber}`) ? "new" : "matched";

  const potential = checked(await db.from("transactions").select("id").eq("workspace_id", workspaceId).eq("account_id", accountId).eq("posted_on", row.postedOn).eq("amount_minor", row.amountMinor.toString()).eq("currency_code", row.currencyCode).eq("description", row.description))!;
  const candidates: { id: string; externalId?: string }[] = [];
  function addCandidate(candidate: { id: string; externalId?: string }) {
    if (!candidates.some(item => item.id === candidate.id && item.externalId === candidate.externalId)) candidates.push(candidate);
  }
  for (const transaction of potential) {
    const sources = checked(await db.from("transaction_sources").select("source_transactions!inner(import_id, external_id)").eq("transaction_id", transaction.id))!;
    if (!sources.length) { addCandidate({ id: transaction.id }); continue; }
    for (const link of sources) {
      const source = link.source_transactions as unknown as { import_id: string; external_id: string | null };
      if (source.import_id !== importId) addCandidate({ id: transaction.id, externalId: source.external_id ?? undefined });
    }
  }
  if (row.externalId) {
    const priorSources = checked(await db.from("source_transactions").select("id").eq("workspace_id", workspaceId).eq("external_id", row.externalId).neq("import_id", importId))!;
    for (const priorSource of priorSources) {
      const priorLink = checked(await db.from("transaction_sources").select("transaction_id").eq("source_transaction_id", priorSource.id))!;
      for (const link of priorLink) {
        const transaction = checked(await db.from("transactions").select("account_id, currency_code, posted_on, amount_minor, description").eq("id", link.transaction_id).single()) as { account_id: string; currency_code: string; posted_on: string; amount_minor: string; description: string };
        if (transaction.account_id === accountId && transaction.currency_code === row.currencyCode) {
          const sameRecord = transaction.posted_on === row.postedOn && BigInt(transaction.amount_minor) === row.amountMinor && transaction.description === row.description;
          addCandidate({ id: link.transaction_id, externalId: sameRecord ? row.externalId : undefined });
        }
      }
    }
  }
  const decision = decideImportMatch(row.externalId, candidates);
  if (decision.action === "review") {
    checked(await db.from("source_transactions").update({ status: "review" }).eq("id", sourceId));
    return "review";
  }
  const transactionId = decision.action === "matched" ? decision.transactionId : stableId(`${importId}:transaction:${row.rowNumber}`);
  if (decision.action === "new") checked(await db.from("transactions").upsert({ id: transactionId, workspace_id: workspaceId, account_id: accountId, posted_on: row.postedOn, description: row.description, amount_minor: row.amountMinor.toString(), currency_code: row.currencyCode }, { onConflict: "id", ignoreDuplicates: true }));
  checked(await db.from("transaction_sources").upsert({ transaction_id: transactionId, source_transaction_id: sourceId }, { onConflict: "source_transaction_id", ignoreDuplicates: true }));
  checked(await db.from("source_transactions").update({ status: decision.action }).eq("id", sourceId));
  if (row.balanceMinor !== undefined) checked(await db.from("balance_snapshots").upsert({ id: stableId(`${importId}:balance:${row.rowNumber}`), workspace_id: workspaceId, account_id: accountId, amount_minor: row.balanceMinor.toString(), currency_code: row.currencyCode, as_of: `${row.postedOn}T00:00:00Z`, provenance: `import:${importId}:row:${row.rowNumber}` }, { onConflict: "id", ignoreDuplicates: true }));
  return decision.action;
}
