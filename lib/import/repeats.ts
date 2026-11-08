import type { SupabaseClient } from "@supabase/supabase-js";
import { allPages } from "@/lib/all-pages";

// Rows from banks without transaction IDs that went to review before Moneo could compare occurrence counts: each overlapping
// sync re-listed rows already in the ledger. A bank's answer is complete for the dates it covers, so if one import states
// no more identical rows than the ledger has, they are all repeats. More than that may be a real second payment: it stays.

export type StagedRow = { sourceId: string; importId: string; status: string; accountId: string; postedOn: string; amountMinor: string; description: string; currencyCode: string; rowStatus: string; externalId: string | null };
type LedgerRow = { id: string; account_id: string; posted_on: string; amount_minor: string; description: string; currency_code: string; status: string };

const fingerprint = (row: Pick<StagedRow, "accountId" | "postedOn" | "amountMinor" | "description" | "currencyCode">) =>
  JSON.stringify([row.accountId, row.postedOn, row.amountMinor, row.description, row.currencyCode]);

/** The waiting rows that are exact repeats: `rows` is every row of those imports, `ledger` the canonical transactions. */
export function waitingRepeats(rows: StagedRow[], ledger: LedgerRow[]) {
  const canonical = new Map<string, number>();
  for (const row of ledger) if (row.status === "posted") {
    const key = fingerprint({ accountId: row.account_id, postedOn: row.posted_on, amountMinor: BigInt(row.amount_minor).toString(), description: row.description, currencyCode: row.currency_code });
    canonical.set(key, (canonical.get(key) ?? 0) + 1);
  }
  const stated = new Map<string, number>();
  for (const row of rows) { const key = `${row.importId}:${fingerprint(row)}`; stated.set(key, (stated.get(key) ?? 0) + 1); }
  return rows.filter(row => row.status === "review" && row.rowStatus === "posted" && !row.externalId
    && (canonical.get(fingerprint(row)) ?? 0) >= stated.get(`${row.importId}:${fingerprint(row)}`)!).map(row => ({ sourceId: row.sourceId, importId: row.importId }));
}

type SourceRow = { id: string; import_id: string; status: string; external_id: string | null; normalized_row: { accountId?: string; row?: { postedOn: string; amountMinor: string; description: string; currencyCode: string; status: string } } | null };

/** Bank windows only: new ones say so; older ones are known by the fixed name and mapping a bank sync gives them. */
export const isBankWindow = (imported: { filename: string; mapping: { completeWindow?: boolean; externalIdColumn?: string } | null }) =>
  imported.mapping?.completeWindow === true || (/ bank sync \d{4}-\d{2}-\d{2}\.csv$/.test(imported.filename) && imported.mapping?.externalIdColumn === "id");

/** What the review page offers to resolve. */
export async function findWaitingRepeats(db: SupabaseClient, workspaceId: string) {
  const waiting = await db.from("source_transactions").select("import_id").eq("workspace_id", workspaceId).eq("status", "review").limit(5000);
  if (waiting.error) throw new Error(waiting.error.message);
  const importIds = [...new Set((waiting.data ?? []).map(row => row.import_id as string))];
  if (!importIds.length) return [];
  const imports = await db.from("imports").select("id, filename, mapping, status").eq("workspace_id", workspaceId).in("id", importIds);
  if (imports.error) throw new Error(imports.error.message);
  const windows = (imports.data ?? []).filter(row => row.status === "completed" && isBankWindow(row)).map(row => row.id as string);
  if (!windows.length) return [];
  const sources = await allPages<SourceRow>((from, to) => db.from("source_transactions").select("id, import_id, status, external_id, normalized_row").eq("workspace_id", workspaceId).in("import_id", windows).order("id").range(from, to) as never);
  const rows = sources.flatMap((row): StagedRow[] => row.normalized_row?.row && row.normalized_row.accountId ? [{ sourceId: row.id, importId: row.import_id, status: row.status, accountId: row.normalized_row.accountId,
    postedOn: row.normalized_row.row.postedOn, amountMinor: BigInt(row.normalized_row.row.amountMinor).toString(), description: row.normalized_row.row.description, currencyCode: row.normalized_row.row.currencyCode, rowStatus: row.normalized_row.row.status, externalId: row.external_id }] : []);
  const days = [...new Set(rows.filter(row => row.status === "review").map(row => row.postedOn))];
  if (!days.length) return [];
  const ledger = await allPages<LedgerRow>((from, to) => db.from("transactions").select("id, account_id, posted_on, amount_minor::text, description, currency_code, status").eq("workspace_id", workspaceId).in("posted_on", days).order("id").range(from, to) as never);
  return waitingRepeats(rows, ledger);
}
