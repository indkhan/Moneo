import type { Db } from "@/lib/database";
import type { NormalizedBankTransaction } from "./normalize";

export type RawContext = NormalizedBankTransaction & { bank_id: string | null };

const RAW_COLUMNS = "row_number, bank_id, payment_type, bank_code, bank_sub_code, mcc, counterparty_name, counterparty_iban, counterparty_bic, counterparty_ids, own_side_ids, creditor_id, mandate_ref, instructed_amount, instructed_currency, exchange_rate, own_account";
const CHUNK = 200;
const chunks = <T,>(items: T[]) => Array.from({ length: Math.ceil(items.length / CHUNK) }, (_, index) => items.slice(index * CHUNK, (index + 1) * CHUNK));

export async function loadRawContext(db: Db, workspaceId: string, transactionIds: string[]): Promise<Map<string, RawContext>> {
  const wanted = new Map<string, { import_id: string; row_number: number }[]>();
  for (const ids of chunks([...new Set(transactionIds)])) {
    const links = await db.from("transaction_sources").select("transaction_id, source_transactions!inner(import_id, row_number, workspace_id)")
      .in("transaction_id", ids).eq("source_transactions.workspace_id", workspaceId);
    if (links.error) throw new Error(links.error.message);
    for (const link of links.data) {
      const sources = Array.isArray(link.source_transactions) ? link.source_transactions : [link.source_transactions];
      wanted.set(link.transaction_id, [...wanted.get(link.transaction_id) ?? [], ...sources.map(({ import_id, row_number }) => ({ import_id, row_number }))]);
    }
  }
  const byImport = new Map<string, Set<number>>();
  for (const sources of wanted.values()) for (const { import_id, row_number } of sources) byImport.set(import_id, (byImport.get(import_id) ?? new Set()).add(row_number));
  const found = new Map<string, RawContext>();
  for (const [importId, rows] of byImport) {
    for (const numbers of chunks([...rows])) {
      const loaded = await db.from("bank_transaction_raw").select(RAW_COLUMNS).eq("workspace_id", workspaceId).eq("import_id", importId).in("row_number", numbers).overrideTypes<(RawContext & { row_number: number })[], { merge: false }>();
      if (loaded.error) throw new Error(loaded.error.message);
      for (const row of loaded.data) found.set(`${importId}:${row.row_number}`, row);
    }
  }
  const context = new Map<string, RawContext>();
  for (const [transactionId, sources] of wanted) {
    const hit = sources.map(source => found.get(`${source.import_id}:${source.row_number}`)).find(Boolean);
    if (hit) context.set(transactionId, hit);
  }
  return context;
}
