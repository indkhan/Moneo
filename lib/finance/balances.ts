import type { SupabaseClient } from "@supabase/supabase-js";
import { calendarDate } from "./calendar";
import { buildSourceCoverage, type loadSourceCoverageMetadata } from "./source-coverage";

export type BalanceAccount = { id: string; name: string; currency_code: string; type?: string; archived_at?: string | null };
export type BalanceSnapshot = { id?: string; account_id: string; amount_minor: string | number; currency_code: string; as_of: string; provenance: string;
  boundary_kind?: string; source_transaction_id?: string | null; covered_transactions?: CoveredTransaction[] | null;
  actor_id?: string | null; undone_at?: string | null; version?: number; created_at?: string };
export type BalanceTransaction = { id: string; account_id: string; amount_minor: string | number; currency_code: string; posted_on: string; status: string;
  posted_at?: string | null; source_transaction_ids?: string[]; version?: number; description?: string;
  kind?: string; review_reasons?: string[]; canonical_amount_minor?: string | number; pending_released_minor?: string };
export type CoveredTransaction = { id: string; version: number; amount_minor: string; currency_code: string; posted_on: string; posted_at: string | null };

// A review records financial fields and canonical identity, never ingestion order.
export function coveredTransaction(row: BalanceTransaction): CoveredTransaction {
  return { id: row.id, version: row.version ?? 0, amount_minor: exactMinor(row.amount_minor).toString(),
    currency_code: row.currency_code, posted_on: row.posted_on, posted_at: row.posted_at ? new Date(row.posted_at).toISOString() : null };
}
export function balanceReviewRows(ledger: BalanceTransaction[], accountId: string, asOf: string, timeZone: string) {
  const today = calendarDate(asOf, timeZone);
  return ledger.filter(row => row.account_id === accountId && row.status === "posted" && exactMinor(row.amount_minor) !== 0n &&
    (row.posted_at ? calendarDate(row.posted_at, timeZone) === today && Date.parse(row.posted_at) <= Date.parse(asOf) : row.posted_on === today))
    .map(coveredTransaction).sort((a, b) => a.id.localeCompare(b.id));
}

function boundaryEvidence(snapshot: BalanceSnapshot) {
  return JSON.stringify([snapshot.boundary_kind ?? "date_only", snapshot.source_transaction_id ?? null,
    [...(snapshot.covered_transactions ?? [])].map(row => coveredTransaction({ ...row, account_id: snapshot.account_id, status: "posted" })).sort((a, b) => a.id.localeCompare(b.id))]);
}

function exactMinor(value: string | number): bigint {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("Unsafe numeric balance evidence");
  return BigInt(value);
}

export function resolveBalances<T extends BalanceAccount>(accounts: T[], snapshots: BalanceSnapshot[], ledger: BalanceTransaction[], asOf = new Date().toISOString(), timeZone = "Europe/Berlin", sourceMetadata?: Awaited<ReturnType<typeof loadSourceCoverageMetadata>>) {
  const today = calendarDate(asOf, timeZone);
  const resolved = accounts.map(account => {
    const candidates = snapshots.filter(snapshot => snapshot.account_id === account.id && !snapshot.undone_at && Number.isFinite(Date.parse(snapshot.as_of)) && Date.parse(snapshot.as_of) <= Date.parse(asOf))
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
      if (ties.some(item => item.currency_code !== snapshot.currency_code || exactMinor(item.amount_minor) !== amount || boundaryEvidence(item) !== boundaryEvidence(snapshot)))
        throw new Error("Conflicting snapshots have no evidenced financial order");
      const boundaryDate = calendarDate(snapshot.as_of, timeZone);
      const covered = new Set<string>();
      if (snapshot.boundary_kind === "reviewed_activity") {
        if (!Array.isArray(snapshot.covered_transactions)) throw new Error("Reviewed activity evidence is missing");
        const rowsById = new Map(ledger.filter(row => row.account_id === account.id && row.status === "posted").map(row => [row.id, row]));
        for (const receipt of snapshot.covered_transactions) {
          const row = rowsById.get(receipt.id);
          if (covered.has(receipt.id) || !row || JSON.stringify(coveredTransaction(row)) !== JSON.stringify(coveredTransaction({ ...receipt, account_id: account.id, status: "posted" })) ||
              row.currency_code !== account.currency_code || (row.posted_at && Date.parse(row.posted_at) > Date.parse(snapshot.as_of)))
            throw new Error("Reviewed activity changed; review the booked balance again");
          covered.add(receipt.id);
        }
      }
      let estimate = amount;
      for (const row of ledger) {
        if (row.account_id !== account.id || row.status !== "posted" || covered.has(row.id)) continue;
        const postingDate = row.posted_at ? calendarDate(row.posted_at, timeZone) : row.posted_on;
        if (postingDate < boundaryDate || postingDate > today ||
            (row.posted_at && Date.parse(row.posted_at) > Date.parse(asOf))) continue;
        const delta = exactMinor(row.amount_minor);
        if (delta === 0n) continue;
        if (snapshot.boundary_kind === "reviewed_activity" && postingDate === boundaryDate) {
          if (!row.posted_at || Date.parse(row.posted_at) <= Date.parse(snapshot.as_of))
            throw new Error("Same-day activity was not covered by the booked balance review");
        } else if (row.posted_at && snapshot.boundary_kind === "after_transaction" && snapshot.source_transaction_id) {
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
  return resolved.map(account => ({ ...account, sourceCoverage: buildSourceCoverage({
    from: account.balance.as_of ? calendarDate(account.balance.as_of, timeZone) : "0001-01-01", to: today,
    accountId: account.id, currencyCode: account.currency_code, ledgerBasis: "balance_activity",
  }, ledger.map(row => ({ ...row, kind: row.kind ?? "ordinary" })), sourceMetadata?.imports, sourceMetadata?.sources) }));
}

// Every reader gets complete, workspace-scoped evidence instead of a silently truncated first page.
export async function loadBalanceEvidence(db: SupabaseClient, workspaceId: string, asOf = new Date().toISOString()): Promise<{
  accounts: BalanceAccount[]; snapshots: BalanceSnapshot[]; ledger: BalanceTransaction[]; asOf: string;
}> {
  async function rows<T>(table: string, columns: string) {
    const result: T[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await db.from(table).select(columns).eq("workspace_id", workspaceId).order("id").range(offset, offset + 499);
      if (page.error) throw page.error;
      result.push(...(page.data ?? []) as unknown as T[]);
      if (!page.data || page.data.length < 500) return result;
    }
  }
  const [accounts, snapshots, ledger, fees, resolutions] = await Promise.all([
    rows<BalanceAccount>("accounts", "id, name, type, currency_code, archived_at"),
    rows<BalanceSnapshot>("balance_snapshots", "id, account_id, amount_minor::text, currency_code, as_of, provenance, boundary_kind, source_transaction_id, covered_transactions, actor_id, undone_at, version, created_at"),
    rows<BalanceTransaction & { transaction_sources?: { source_transaction_id: string }[] }>("transactions", "id, account_id, amount_minor::text, currency_code, posted_on, posted_at, status, version, description, kind, review_reasons, transaction_sources(source_transaction_id)"),
    rows<{ transaction_id: string; fee_minor: string; treatment: string; transaction_links: { undone_at: string | null } }>("transaction_link_fees", "id, transaction_id, fee_minor::text, treatment, transaction_links!inner(undone_at)"),
    rows<{ pending_transaction_id: string | null; released_minor: string; undone_at: string | null }>("pending_hold_resolutions", "id, pending_transaction_id, released_minor::text, undone_at"),
  ]);
  const released = new Map<string, bigint>();
  for (const resolution of resolutions) if (!resolution.undone_at && resolution.pending_transaction_id) {
    released.set(resolution.pending_transaction_id, (released.get(resolution.pending_transaction_id) ?? 0n) + exactMinor(resolution.released_minor));
  }
  const additionalFees = new Map<string, bigint>();
  for (const fee of fees) {
    if (fee.treatment !== "additional" || fee.transaction_links.undone_at !== null) continue;
    const amount = exactMinor(fee.fee_minor);
    if (amount <= 0n) throw new Error("Invalid verified additional fee");
    additionalFees.set(fee.transaction_id, (additionalFees.get(fee.transaction_id) ?? 0n) + amount);
  }
  return { accounts, snapshots, ledger: ledger.map(row => ({ ...row,
    pending_released_minor: (released.get(row.id) ?? 0n).toString(),
    canonical_amount_minor: row.amount_minor,
    // This is derived balance evidence; the source posting and its boundary identity remain unchanged.
    amount_minor: additionalFees.has(row.id) ? (exactMinor(row.amount_minor) - additionalFees.get(row.id)!).toString() : row.amount_minor,
    source_transaction_ids: row.transaction_sources?.map(source => source.source_transaction_id) ?? [] })), asOf };
}
