"use workflow";

import { createHash } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { decideImportMatch } from "@/lib/import-match";
import { inspectRows, parseCsv, parseExcel, type MappedRow } from "@/lib/csv";
import { modelForSettings } from "@/lib/ai/provider";
import { loadWorkspaceSettings, requireAiScope } from "@/lib/settings";
import { importRowPayload, stableId } from "@/lib/import-row";
import { dispatchFinancialReview } from "@/lib/finance/start-review";

function checked<T>(result: { data: T | null; error: { message: string } | null }): T | null {
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

export async function importFile(importId: string, workspaceId: string, rowCount: number, runVersion = 1) {
  "use workflow";
  try {
    let newRows = 0, matchedRows = 0, reviewRows = 0;
    for (let offset = 0; offset < rowCount; offset += 250) {
      const counts = await processImport(importId, workspaceId, offset, Math.min(offset + 250, rowCount), { newRows, matchedRows, reviewRows }, runVersion);
      newRows = counts.newRows;
      matchedRows = counts.matchedRows;
      reviewRows = counts.reviewRows;
    }
    if (!await finishImport(importId, workspaceId, runVersion)) return;
  } catch (error) {
    await failImport(importId, workspaceId, String(error), runVersion);
    return;
  }
  await maybeStartFirstReview(importId, workspaceId);
}

async function processImport(importId: string, workspaceId: string, from: number, to: number, prior: { newRows: number; matchedRows: number; reviewRows: number }, runVersion: number) {
  "use step";
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase import service is not configured");
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const imported = checked(await db.from("imports").select("*").eq("id", importId).eq("workspace_id", workspaceId).single()) as { status: string; run_version: number; source_id?: string | null; route_accounts?: Record<string, string>; storage_path: string; file_hash: string; mapping: unknown };
  if (imported.status === "completed") return prior;
  if (!["queued", "running"].includes(imported.status) || imported.run_version !== runVersion) throw new Error("Import worker canceled or superseded");
  if (!imported.storage_path.startsWith(`${workspaceId}/`)) throw new Error("Import file is outside the workspace");
  const blob = checked(await db.storage.from("imports").download(imported.storage_path));
    if (!blob) throw new Error("Stored import file is missing");
    if (blob.size > 10_000_000) throw new Error("Stored import file exceeds the 10 MB limit");
    const bytes = await blob.arrayBuffer();
    if (createHash("sha256").update(new Uint8Array(bytes)).digest("hex") !== imported.file_hash) throw new Error("Stored import file differs from the reviewed original");
    const extension = imported.storage_path.split(".").pop();
    const rows = extension === "csv" ? parseCsv(new TextDecoder().decode(bytes)) : await parseExcel(bytes);
    const { mapped, unresolvedRows, excludedRows } = inspectRows(rows, imported.mapping);
    if (unresolvedRows.length) throw new Error(unresolvedRows[0].message);
    const accountIds = new Map<string, string>();
    const frozenAccounts = new Map(Object.entries(imported.route_accounts ?? {}).map(([route, accountId]) => [JSON.stringify(JSON.parse(route)), accountId]));
    const legacyPrepared = frozenAccounts.size === 0 && !!imported.source_id;
    if (legacyPrepared) {
      const firstSource = checked(await db.from("data_sources").select("account_id").eq("workspace_id", workspaceId).eq("id", imported.source_id!).eq("kind", "file").single()) as { account_id: string | null };
      if (!firstSource.account_id || !mapped[0]) throw new Error("Legacy import route evidence is unavailable");
      frozenAccounts.set(JSON.stringify([mapped[0].accountName, mapped[0].currencyCode]), firstSource.account_id);
      const byNumber = new Map(mapped.map(row => [row.rowNumber, row]));
      type LegacySource = { row_number: number; transaction_sources: { transactions: { account_id: string } | null }[] | { transactions: { account_id: string } | null } | null };
      for (let offset = 0; ; offset += 500) {
        const sources = checked(await db.from("source_transactions").select("row_number, transaction_sources(transactions(account_id))").eq("workspace_id", workspaceId).eq("import_id", importId).order("id").range(offset, offset + 499)) as unknown as LegacySource[];
        for (const source of sources) {
          const mappedRow = byNumber.get(source.row_number);
          const links = Array.isArray(source.transaction_sources) ? source.transaction_sources : [source.transaction_sources];
          for (const link of links) if (link?.transactions?.account_id) {
            if (!mappedRow) throw new Error("Legacy source row differs from the reviewed file");
            const route = JSON.stringify([mappedRow.accountName, mappedRow.currencyCode]);
            if (frozenAccounts.has(route) && frozenAccounts.get(route) !== link.transactions.account_id) throw new Error("Legacy import route has conflicting account evidence");
            frozenAccounts.set(route, link.transactions.account_id);
          }
        }
        if (sources.length < 500) break;
      }
    }
    for (const row of mapped) {
      const routeKey = JSON.stringify([row.accountName, row.currencyCode]);
      if (accountIds.has(routeKey)) continue;
      const frozenAccountId = frozenAccounts.get(routeKey);
      if (legacyPrepared && !frozenAccountId) throw new Error("Legacy partial import route needs review before resume");
      let accountQuery = db.from("accounts").select("id, archived_at").eq("workspace_id", workspaceId).eq("currency_code", row.currencyCode);
      accountQuery = frozenAccountId ? accountQuery.eq("id", frozenAccountId) : accountQuery.eq("name", row.accountName);
      const existingAccount = checked(await accountQuery.limit(2))!;
      if (existingAccount.length > 1) throw new Error("Reviewed import account is ambiguous");
      if (frozenAccountId && !existingAccount.length) throw new Error("Frozen import account unavailable; review the destination before resume");
      if (existingAccount[0]?.archived_at) throw new Error("Archived accounts cannot receive new imports");
      const accountId = frozenAccountId ?? existingAccount[0]?.id ?? stableId(`${workspaceId}:account:${row.accountName}:${row.currencyCode}`);
      accountIds.set(routeKey, accountId);
      const sourceId = stableId(`${workspaceId}:source:${accountId}`);
      checked(await db.rpc("prepare_import_route", { p_import_id: importId, p_workspace_id: workspaceId, p_run_version: runVersion,
        p_account_id: accountId, p_source_id: sourceId, p_account_name: row.accountName, p_currency_code: row.currencyCode, p_total_rows: rows.length }));
    }

    for (const row of excludedRows.filter(row => row.rowNumber >= from + 2 && row.rowNumber < to + 2)) {
      checked(await db.rpc("record_import_exclusion", { p_import_id: importId, p_workspace_id: workspaceId, p_run_version: runVersion,
        p_row: { sourceId: stableId(`${importId}:row:${row.rowNumber}`), rowNumber: row.rowNumber, originalRow: row.sourceRow, reason: row.reason } }));
    }
    const chunk = mapped.filter(row => row.rowNumber >= from + 2 && row.rowNumber < to + 2);
    for (const [index, row] of chunk.entries()) {
      await importRow(db, workspaceId, importId, accountIds.get(JSON.stringify([row.accountName, row.currencyCode]))!, row, runVersion,
        (index + 1) % 25 === 0 || index + 1 === chunk.length);
    }
    const counts = checked(await db.from("imports").select("new_rows, matched_rows, review_rows").eq("id", importId).eq("workspace_id", workspaceId).single()) as { new_rows: number; matched_rows: number; review_rows: number };
    return { newRows: counts.new_rows, matchedRows: counts.matched_rows, reviewRows: counts.review_rows };
}

async function finishImport(importId: string, workspaceId: string, runVersion: number) {
  "use step";
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  return checked(await db.rpc("finish_import_run", { p_import_id: importId, p_workspace_id: workspaceId, p_run_version: runVersion, p_error: null })) === "completed";
}

async function failImport(importId: string, workspaceId: string, error: string, runVersion: number) {
  "use step";
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  checked(await db.rpc("finish_import_run", { p_import_id: importId, p_workspace_id: workspaceId, p_run_version: runVersion, p_error: error }));
}

async function maybeStartFirstReview(importId: string, workspaceId: string) {
  "use step";
  if (!process.env.OPENROUTER_API_KEY || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL) return;
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const settings = await loadWorkspaceSettings(db, workspaceId);
  try {
    requireAiScope(settings, "accounts", "transactions");
  } catch { return; } // Analysis eligibility is optional; the completed import remains valid.
  await modelForSettings(settings);
  const first = await db.from("imports").select("id").eq("workspace_id", workspaceId).eq("status", "completed").gt("new_rows", 0).order("created_at").order("id").limit(1).maybeSingle();
  if (first.error) throw first.error;
  if (first.data?.id !== importId) return;
  const jobId = stableId(`${workspaceId}:first-financial-review`);
  const inserted = await db.from("background_jobs").upsert({ id: jobId, workspace_id: workspaceId, kind: "financial_review" }, { onConflict: "id", ignoreDuplicates: true }).select("id").maybeSingle();
  if (inserted.error) throw inserted.error;
  await dispatchFinancialReview(db, jobId, workspaceId, false);
}

type Db = SupabaseClient;

async function importRow(db: Db, workspaceId: string, importId: string, accountId: string, row: MappedRow, runVersion: number, reportProgress: boolean): Promise<void> {
  const sourceId = stableId(`${importId}:row:${row.rowNumber}`);
  const source = checked(await db.from("source_transactions").select("status").eq("workspace_id", workspaceId).eq("import_id", importId).eq("id", sourceId).maybeSingle()) as { status: string } | null;
  const linkResult = await db.from("transaction_sources").select("transaction_id").eq("source_transaction_id", sourceId).maybeSingle();
  if (linkResult.error) throw linkResult.error;
  const linked = linkResult.data as { transaction_id: string } | null;
  const write = async (action: string, transactionId: string | null, expectedTransactionVersion?: number) => {
    checked(await db.rpc("ingest_import_row", { p_import_id: importId, p_workspace_id: workspaceId, p_run_version: runVersion, p_account_id: accountId,
      p_row: { ...importRowPayload(workspaceId, importId, row), transactionId, action, expectedTransactionVersion, reportProgress } }));
  };
  if (linked) { await write(source?.status === "matched" ? "matched" : "new", linked.transaction_id); return; }
  if (source?.status === "review" || source?.status === "rejected") { await write("review", null); return; }

  const potential = checked(await db.from("transactions").select("id, status").eq("workspace_id", workspaceId).eq("account_id", accountId).eq("posted_on", row.postedOn).eq("amount_minor", row.amountMinor.toString()).eq("currency_code", row.currencyCode).eq("description", row.description))!;
  const candidates: { id: string; externalId?: string; status?: string }[] = [];
  function addCandidate(candidate: { id: string; externalId?: string; status?: string }) {
    if (!candidates.some(item => item.id === candidate.id && item.externalId === candidate.externalId && (item.status ?? "posted") === (candidate.status ?? "posted"))) candidates.push(candidate);
  }
  for (const transaction of potential) {
    const sources = checked(await db.from("transaction_sources").select("source_transactions!inner(import_id, external_id)").eq("transaction_id", transaction.id))!;
    if (!sources.length) { addCandidate({ id: transaction.id, status: (transaction as { status?: string }).status }); continue; }
    for (const link of sources) {
      const source = link.source_transactions as unknown as { import_id: string; external_id: string | null };
      if (source.import_id !== importId) addCandidate({ id: transaction.id, externalId: source.external_id ?? undefined, status: (transaction as { status?: string }).status });
    }
  }
  if (row.externalId) {
    const priorSources = checked(await db.from("source_transactions").select("id").eq("workspace_id", workspaceId).eq("external_id", row.externalId).neq("import_id", importId))!;
    for (const priorSource of priorSources) {
      const priorLink = checked(await db.from("transaction_sources").select("transaction_id").eq("source_transaction_id", priorSource.id))!;
      for (const link of priorLink) {
        const transaction = checked(await db.from("transactions").select("account_id, currency_code, posted_on, amount_minor::text, description, status").eq("id", link.transaction_id).single()) as { account_id: string; currency_code: string; posted_on: string; amount_minor: string; description: string; status: string };
        if (transaction.account_id === accountId && transaction.currency_code === row.currencyCode) {
          const sameRecord = transaction.posted_on === row.postedOn && BigInt(transaction.amount_minor) === row.amountMinor && transaction.description === row.description;
          addCandidate({ id: link.transaction_id, externalId: sameRecord ? row.externalId : undefined, status: transaction.status });
        }
      }
    }
  }
  const decision = decideImportMatch(row.externalId, candidates, row.status);
  if (decision.action === "review") {
    await write("review", null); return;
  }
  const transactionId = decision.action === "matched" ? decision.transactionId : stableId(`${importId}:transaction:${row.rowNumber}`);
  const canonical = decision.action === "matched" ? checked(await db.from("transactions").select("version").eq("workspace_id", workspaceId).eq("id", transactionId).single()) as { version: number } : null;
  await write(decision.action, transactionId, canonical?.version);
}
