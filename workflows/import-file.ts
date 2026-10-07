"use workflow";

import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { inspectRows, mappingSchema, parseCsv, parseExcel, parseLegacyExcel } from "@/lib/csv";
import { modelForSettings } from "@/lib/ai/provider";
import { loadWorkspaceSettings, requireAiScope } from "@/lib/settings";
import { stableId } from "@/lib/import-row";
import { batchDecisions, candidateRowsSchema, stageImportRows } from "@/lib/import-batch";
import { dispatchFinancialReview } from "@/lib/finance/start-review";

function checked<T>(result: { data: T | null; error: { message: string } | null }): T | null {
  if (result.error) throw new Error(result.error.message);
  return result.data;
}

export async function importFile(importId: string, workspaceId: string, rowCount: number, runVersion = 1) {
  "use workflow";
  try {
    const stagedRows = rowCount === 0 ? 0 : await prepareImport(importId, workspaceId, rowCount, runVersion);
    for (let offset = 0; offset < stagedRows; offset += 250) {
      await processImportBatch(importId, workspaceId, offset, runVersion);
    }
    if (!await finishImport(importId, workspaceId, runVersion)) return;
  } catch (error) {
    await failImport(importId, workspaceId, String(error), runVersion);
    return;
  }
  await maybeStartFirstReview(importId, workspaceId);
}

async function prepareImport(importId: string, workspaceId: string, rowCount: number, runVersion: number) {
  "use step";
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase import service is not configured");
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const imported = checked(await db.from("imports").select("*").eq("id", importId).eq("workspace_id", workspaceId).single()) as { status: string; run_version: number; source_id?: string | null; route_accounts?: Record<string, string>; storage_path: string; file_hash: string; mapping: unknown };
  if (imported.status === "completed") return 0;
  if (!["queued", "running"].includes(imported.status) || imported.run_version !== runVersion) throw new Error("Import worker canceled or superseded");
  const stagedCount = checked(await db.rpc("read_import_stage", { p_import_id: importId, p_workspace_id: workspaceId, p_run_version: runVersion }));
  if (stagedCount !== null) {
    if (stagedCount !== rowCount) throw new Error("Normalized import coverage differs from reviewed rows");
    return rowCount;
  }
  if (!imported.storage_path.startsWith(`${workspaceId}/`)) throw new Error("Import file is outside the workspace");
  const blob = checked(await db.storage.from("imports").download(imported.storage_path));
    if (!blob) throw new Error("Stored import file is missing");
    if (blob.size > 10_000_000) throw new Error("Stored import file exceeds the 10 MB limit");
    const bytes = await blob.arrayBuffer();
    if (createHash("sha256").update(new Uint8Array(bytes)).digest("hex") !== imported.file_hash) throw new Error("Stored import file differs from the reviewed original");
    const extension = imported.storage_path.split(".").pop();
    const confirmedMapping = mappingSchema.parse(imported.mapping);
    const rows = extension === "csv" ? parseCsv(new TextDecoder().decode(bytes)) : confirmedMapping.workbookScope ? await parseExcel(bytes, confirmedMapping.workbookScope) : await parseLegacyExcel(bytes);
    const { mapped, unresolvedRows, excludedRows } = inspectRows(rows, imported.mapping);
    if (unresolvedRows.length) throw new Error(unresolvedRows[0].message);
    const accountIds = new Map<string, string>();
    let preparedSourceId = imported.source_id ?? null;
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
      preparedSourceId ??= sourceId;
      checked(await db.rpc("prepare_import_route", { p_import_id: importId, p_workspace_id: workspaceId, p_run_version: runVersion,
        p_account_id: accountId, p_source_id: sourceId, p_account_name: row.accountName, p_currency_code: row.currencyCode, p_total_rows: rows.length }));
    }

    const stagedRows = stageImportRows(workspaceId, importId, mapped, excludedRows, accountIds, rowCount);
    checked(await db.rpc("stage_import_rows", { p_import_id: importId, p_workspace_id: workspaceId, p_run_version: runVersion, p_file_hash: imported.file_hash,
      p_mapping: imported.mapping, p_routes: imported.route_accounts ?? {}, p_source_id: preparedSourceId, p_rows: stagedRows }));
    return rowCount;
}

async function processImportBatch(importId: string, workspaceId: string, offset: number, runVersion: number) {
  "use step";
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  // Retry stale candidate evidence inside the same durable step. Every attempt
  // rereads candidates and every batch transaction fences canceled/old workers.
  for (let attempt = 0; attempt < 3; attempt++) {
    const candidates = checked(await db.rpc("import_batch_candidates", { p_import_id: importId, p_workspace_id: workspaceId, p_run_version: runVersion, p_offset: offset }));
    const decisions = batchDecisions(candidateRowsSchema.parse(candidates));
    const result = await db.rpc("ingest_import_batch", { p_import_id: importId, p_workspace_id: workspaceId, p_run_version: runVersion, p_offset: offset, p_decisions: decisions });
    if (!result.error) return;
    if (result.error.code !== "40001" || attempt === 2) throw new Error(result.error.message);
  }
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

