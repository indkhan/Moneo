import type { SupabaseClient } from "@supabase/supabase-js";
import { calendarDate } from "./calendar";

export type BalanceAccount = { id: string; name: string; currency_code: string; type?: string };
export type BalanceSnapshot = { id?: string; account_id: string; amount_minor: string | number; currency_code: string; as_of: string; provenance: string;
  boundary_kind?: string; source_transaction_id?: string | null };
export type BalanceTransaction = { id: string; account_id: string; amount_minor: string | number; currency_code: string; posted_on: string; status: string;
  posted_at?: string | null; source_transaction_ids?: string[] };

function exactMinor(value: string | number): bigint {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("Unsafe numeric balance evidence");
  return BigInt(value);
}

export function resolveBalances<T extends BalanceAccount>(accounts: T[], snapshots: BalanceSnapshot[], ledger: BalanceTransaction[], asOf = new Date().toISOString(), timeZone = "Europe/Berlin") {
  const today = calendarDate(asOf, timeZone);
  return accounts.map(account => {
    const candidates = snapshots.filter(snapshot => snapshot.account_id === account.id && Number.isFinite(Date.parse(snapshot.as_of)) && Date.parse(snapshot.as_of) <= Date.parse(asOf))
      .sort((a, b) => Date.parse(b.as_of) - Date.parse(a.as_of));
    const snapshot = candidates[0];
    const balance = { amount_minor: null as string | null, snapshot_amount_minor: null as string | null,
      estimated_amount_minor: null as string | null, currency_code: account.currency_code,
      snapshot_currency_code: snapshot?.currency_code ?? null, as_of: snapshot?.as_of ?? null,
      evaluated_at: asOf, provenance: snapshot?.provenance ?? null, status: "missing" as "current" | "stale" | "ambiguous" | "missing",
      warnings: [] as string[], reconciled_rows: 0 };
    if (!snapshot) { balance.warnings.push("No dated balance at or before the evaluation time"); return { ...account, balance }; }
    try {
      const amount = exactMinor(snapshot.amount_minor);
      balance.snapshot_amount_minor = amount.toString();
      if (snapshot.currency_code !== account.currency_code) throw new Error("Snapshot currency differs from account currency");
      const ties = candidates.filter(item => Date.parse(item.as_of) === Date.parse(snapshot.as_of));
      if (ties.some(item => item.currency_code !== snapshot.currency_code || exactMinor(item.amount_minor) !== amount))
        throw new Error("Conflicting snapshots have no evidenced financial order");
      const boundaryDate = calendarDate(snapshot.as_of, timeZone);
      let estimate = amount;
      for (const row of ledger) {
        if (row.account_id !== account.id || row.status !== "posted") continue;
        const postingDate = row.posted_at ? calendarDate(row.posted_at, timeZone) : row.posted_on;
        if (postingDate < boundaryDate || postingDate > today ||
            (row.posted_at && Date.parse(row.posted_at) > Date.parse(asOf))) continue;
        const delta = exactMinor(row.amount_minor);
        if (delta === 0n) continue;
        if (row.posted_at && snapshot.boundary_kind === "after_transaction" && snapshot.source_transaction_id) {
          const postingTime = Date.parse(row.posted_at), boundaryTime = Date.parse(snapshot.as_of);
          if (postingTime < boundaryTime) continue;
          if (postingTime === boundaryTime) {
            if (row.source_transaction_ids?.includes(snapshot.source_transaction_id)) continue;
            throw new Error("Same-timestamp ledger has no evidenced order relative to the snapshot");
          }
        } else if (postingDate === boundaryDate) throw new Error("Same-day ledger has no evidenced snapshot boundary");
        if (row.currency_code !== account.currency_code) throw new Error("Ledger currency differs from account currency");
        estimate += delta;
        balance.reconciled_rows++;
      }
      balance.estimated_amount_minor = estimate.toString();
      balance.status = boundaryDate === today ? "current" : "stale";
      if (balance.status === "current") balance.amount_minor = estimate.toString();
      else balance.warnings.push("Dated balance plus recorded later activity; completeness through today is unverified");
    } catch (error) {
      balance.status = "ambiguous";
      balance.estimated_amount_minor = null;
      balance.warnings.push(error instanceof Error ? error.message : "Invalid balance evidence");
    }
    return { ...account, balance };
  });
}

// Every reader gets complete, workspace-scoped evidence instead of a silently truncated first page.
export async function loadBalanceEvidence(db: SupabaseClient, workspaceId: string, asOf = new Date().toISOString()) {
  async function rows<T>(table: string, columns: string) {
    const result: T[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await db.from(table).select(columns).eq("workspace_id", workspaceId).order("id").range(offset, offset + 499);
      if (page.error) throw page.error;
      result.push(...(page.data ?? []) as unknown as T[]);
      if (!page.data || page.data.length < 500) return result;
    }
  }
  const [accounts, snapshots, ledger] = await Promise.all([
    rows<BalanceAccount>("accounts", "id, name, type, currency_code"),
    rows<BalanceSnapshot>("balance_snapshots", "id, account_id, amount_minor::text, currency_code, as_of, provenance, boundary_kind, source_transaction_id"),
    rows<BalanceTransaction & { transaction_sources?: { source_transaction_id: string }[] }>("transactions", "id, account_id, amount_minor::text, currency_code, posted_on, posted_at, status, transaction_sources(source_transaction_id)"),
  ]);
  return { accounts, snapshots, ledger: ledger.map(row => ({ ...row, source_transaction_ids: row.transaction_sources?.map(source => source.source_transaction_id) ?? [] })), asOf };
}
