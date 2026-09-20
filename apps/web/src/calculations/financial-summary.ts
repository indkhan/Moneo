import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { formatSignedDecimalBigint, formatDecimalBigint } from "../money.ts";
import { TenantInvalid, withTenant, type TenantClaims } from "../tenancy.ts";
import { isUuid } from "../ids.ts";
import { calculateWorkspaceTotals, classifyLeg, type TransactionLeg } from "./cash.ts";
import { valuateSnapshot } from "./fx.ts";

type Row = { id: string; account_id: string; amount_minor: string; currency: string; direction: "INFLOW" | "OUTFLOW"; effective_date: string | Date; description: string; financial_kind: "NORMAL" | "TRANSFER" | "FEE" | "REFUND" | "CREDIT_REPAYMENT"; linked_account_id: string | null; source: "imported" | "manual" };
export type FinancialSummary = { baseCurrency: string; base: { incomeMinor: string; spendMinor: string; cashMinor: string; coverage: "full" | "partial" | "unavailable"; unvaluedCount: string }; native: ReturnType<typeof calculateWorkspaceTotals>["byCurrency"]; calculationVersion: string; inputsHash: string; resultsHash: string };

const date = (value: string | Date) => value instanceof Date ? value.toISOString().slice(0, 10) : value;
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function getFinancialSummary(pool: Pool, claims: TenantClaims, workspaceId: string, filter: { accountId?: string; dateFrom?: string; dateTo?: string } = {}): Promise<FinancialSummary> {
  if (workspaceId !== claims.workspaceId) throw new TenantInvalid();
  if (filter.accountId !== undefined && !isUuid(filter.accountId)) throw new TenantInvalid();
  for (const value of [filter.dateFrom, filter.dateTo]) if (value !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TenantInvalid();
  return withTenant(pool, claims, async (client) => {
    await client.query("LOCK TABLE transactions, manual_transactions, accounts, fx_rates_ecb, fx_rates_manual IN SHARE MODE");
    const workspace = await client.query("SELECT base_currency_code FROM workspaces WHERE id = $1 FOR UPDATE", [workspaceId]);
    if ((workspace.rowCount ?? 0) === 0) throw new TenantInvalid();
    const baseCurrency = (workspace.rows[0] as { base_currency_code: string }).base_currency_code.trim();
    const accountsRows = await client.query("SELECT id, base_currency_code FROM accounts WHERE workspace_id = $1 AND archived = false ORDER BY id", [workspaceId]);
    const accounts = new Map((accountsRows.rows as { id: string; base_currency_code: string }[]).map((r) => [r.id, { currency: r.base_currency_code.trim() }]));
    const ids = new Set(accounts.keys());
    const rows = await client.query(
      `SELECT id, account_id, amount_minor, currency, direction, effective_date, description, financial_kind, linked_account_id, 'imported' AS source FROM transactions WHERE workspace_id = $1
       UNION ALL
       SELECT id, account_id, amount_minor, currency, direction, effective_date, description, financial_kind, linked_account_id, 'manual' AS source FROM manual_transactions WHERE workspace_id = $1
       ORDER BY effective_date, id`, [workspaceId],
    );
    const selectedRows = (rows.rows as Row[]).filter((r) => (!filter.accountId || r.account_id === filter.accountId) && (!filter.dateFrom || date(r.effective_date) >= filter.dateFrom) && (!filter.dateTo || date(r.effective_date) <= filter.dateTo));
    const legs = selectedRows.map((r): TransactionLeg => ({ accountId: r.account_id, amountMinor: BigInt(r.amount_minor), currency: r.currency.trim(), direction: r.direction, effectiveDate: date(r.effective_date), description: r.description, source: r.source, counterpartyAccountId: r.linked_account_id ?? undefined, isFee: r.financial_kind === "FEE", isRefund: r.financial_kind === "REFUND", isCreditRepayment: r.financial_kind === "CREDIT_REPAYMENT" }));
    const classified = legs.map((leg) => classifyLeg(leg, ids));
    const native = calculateWorkspaceTotals(classified, accounts).byCurrency;

    const ecbRows = await client.query("SELECT rate_date, target_currency, rate FROM fx_rates_ecb WHERE workspace_id = $1 ORDER BY rate_date, target_currency", [workspaceId]);
    const ecb = new Map<string, Map<string, string>>();
    for (const r of ecbRows.rows as { rate_date: string | Date; target_currency: string; rate: string }[]) { const d = date(r.rate_date); const m = ecb.get(d) ?? new Map(); m.set(r.target_currency.trim(), r.rate); ecb.set(d, m); }
    const manualRows = await client.query("SELECT rate_date, base_currency, target_currency, rate FROM fx_rates_manual WHERE workspace_id = $1 ORDER BY rate_date, base_currency, target_currency", [workspaceId]);
    const manual = new Map<string, Map<string, Map<string, string>>>();
    for (const r of manualRows.rows as { rate_date: string | Date; base_currency: string; target_currency: string; rate: string }[]) { const d = date(r.rate_date); const byBase = manual.get(d) ?? new Map(); const targets = byBase.get(r.base_currency.trim()) ?? new Map(); targets.set(r.target_currency.trim(), r.rate); byBase.set(r.base_currency.trim(), targets); manual.set(d, byBase); }

    let income = 0n, spend = 0n, unvalued = 0n; let partial = false;
    for (let i = 0; i < classified.length; i++) {
      const leg = classified[i]!;
      if (leg.classification === "transfer_principal" || leg.classification === "credit_repayment") continue;
      const valued = valuateSnapshot({ snapshotId: selectedRows[i]!.id, accountId: leg.accountId, asOfDate: leg.effectiveDate, amountMinor: leg.amountMinor, currency: leg.currency, baseCurrency }, ecb, manual);
      if (valued.coverage === "unavailable") { unvalued++; continue; }
      if (valued.coverage === "partial") partial = true;
      if (leg.classification === "income") income += valued.valuedAmountMinor;
      else if (leg.classification === "refund") spend -= valued.valuedAmountMinor;
      else spend += valued.valuedAmountMinor;
    }
    const coverage = unvalued > 0n ? (income === 0n && spend === 0n ? "unavailable" : "partial") : partial ? "partial" : "full";
    const base = { incomeMinor: formatSignedDecimalBigint(income), spendMinor: formatSignedDecimalBigint(spend), cashMinor: formatSignedDecimalBigint(income - spend), coverage, unvaluedCount: unvalued.toString() } as const;
    const canonicalInputs = selectedRows.map((r) => ({ ...r, effective_date: date(r.effective_date), amount_minor: String(r.amount_minor), currency: r.currency.trim() }));
    const canonicalEcb = (ecbRows.rows as { rate_date: string | Date; target_currency: string; rate: string }[]).map((r) => ({ rateDate: date(r.rate_date), targetCurrency: r.target_currency.trim(), rate: r.rate }));
    const canonicalManual = (manualRows.rows as { rate_date: string | Date; base_currency: string; target_currency: string; rate: string }[]).map((r) => ({ rateDate: date(r.rate_date), baseCurrency: r.base_currency.trim(), targetCurrency: r.target_currency.trim(), rate: r.rate }));
    const inputsHash = sha({ baseCurrency, filter, accounts: [...accounts.entries()], rows: canonicalInputs, ecb: canonicalEcb, manual: canonicalManual });
    const resultsHash = sha({ base, native });
    const prior = await client.query("SELECT COALESCE(MAX(version), 0) AS version FROM calculation_versions WHERE workspace_id = $1", [workspaceId]);
    const calculationVersion = (BigInt((prior.rows[0] as { version: string }).version) + 1n).toString();
    await client.query("INSERT INTO calculation_versions (workspace_id, version, inputs_hash, results_hash) VALUES ($1, $2, $3, $4)", [workspaceId, calculationVersion, inputsHash, resultsHash]);
    return { baseCurrency, base, native, calculationVersion, inputsHash, resultsHash };
  });
}

// E05-S03 Finance SDK functions for artifact runtime

export async function getSpendingByCategory(
  pool: Pool,
  claims: TenantClaims,
  filter: { dateFrom?: string; dateTo?: string; accountIds?: string[] } = {}
): Promise<Array<{ label: string; amount: string }>> {
  if (filter.accountIds !== undefined && !filter.accountIds.every(isUuid)) throw new TenantInvalid();
  for (const value of [filter.dateFrom, filter.dateTo]) if (value !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TenantInvalid();
  return withTenant(pool, claims, async (client) => {
    let query = `SELECT COALESCE(c.name, 'Uncategorized') AS label, SUM(t.amount_minor)::text AS amount
      FROM transactions t
      LEFT JOIN categories c ON c.workspace_id = t.workspace_id AND c.id = t.category_id
      WHERE t.workspace_id = $1`;
    const params: unknown[] = [claims.workspaceId];
    let paramIdx = 2;
    if (filter.dateFrom) { query += ` AND t.effective_date >= $${paramIdx++}`; params.push(filter.dateFrom); }
    if (filter.dateTo) { query += ` AND t.effective_date <= $${paramIdx++}`; params.push(filter.dateTo); }
    if (filter.accountIds) {
      const placeholders = filter.accountIds.map(() => `$${paramIdx++}`).join(",");
      query += ` AND t.account_id IN (${placeholders})`;
      params.push(...filter.accountIds);
    }
    query += ` GROUP BY label ORDER BY amount DESC`;
    const rows = await client.query(query, params);
    return rows.rows as Array<{ label: string; amount: string }>;
  });
}

export async function getCashflow(
  pool: Pool,
  claims: TenantClaims,
  filter: { dateFrom?: string; dateTo?: string; accountIds?: string[] } = {}
): Promise<Array<{ date: string; inflow: string; outflow: string }>> {
  if (filter.accountIds !== undefined && !filter.accountIds.every(isUuid)) throw new TenantInvalid();
  for (const value of [filter.dateFrom, filter.dateTo]) if (value !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TenantInvalid();
  return withTenant(pool, claims, async (client) => {
    let query = `SELECT effective_date, 
      SUM(CASE WHEN direction = 'INFLOW' THEN amount_minor ELSE 0 END)::text AS inflow,
      SUM(CASE WHEN direction = 'OUTFLOW' THEN amount_minor ELSE 0 END)::text AS outflow
      FROM transactions WHERE workspace_id = $1`;
    const params: unknown[] = [claims.workspaceId];
    let paramIdx = 2;
    if (filter.dateFrom) { query += ` AND effective_date >= $${paramIdx++}`; params.push(filter.dateFrom); }
    if (filter.dateTo) { query += ` AND effective_date <= $${paramIdx++}`; params.push(filter.dateTo); }
    if (filter.accountIds) {
      const placeholders = filter.accountIds.map(() => `$${paramIdx++}`).join(",");
      query += ` AND account_id IN (${placeholders})`;
      params.push(...filter.accountIds);
    }
    query += ` GROUP BY effective_date ORDER BY effective_date`;
    const rows = await client.query(query, params);
    return rows.rows as Array<{ date: string; inflow: string; outflow: string }>;
  });
}

export async function getBalances(
  pool: Pool,
  claims: TenantClaims,
  filter: { accountIds?: string[] } = {}
): Promise<Array<{ accountId: string; amount: string; currency: string }>> {
  if (filter.accountIds !== undefined && !filter.accountIds.every(isUuid)) throw new TenantInvalid();
  return withTenant(pool, claims, async (client) => {
    let query = `SELECT DISTINCT ON (b.account_id) b.account_id, b.amount_minor, b.currency
      FROM balance_snapshots b
      JOIN accounts a ON a.workspace_id = b.workspace_id AND a.id = b.account_id
      WHERE b.workspace_id = $1 AND a.archived = false`;
    const params: unknown[] = [claims.workspaceId];
    let paramIdx = 2;
    if (filter.accountIds) {
      const placeholders = filter.accountIds.map(() => `$${paramIdx++}`).join(",");
      query += ` AND b.account_id IN (${placeholders})`;
      params.push(...filter.accountIds);
    }
    query += ` ORDER BY b.account_id, b.observed_at DESC`;
    const rows = await client.query(query, params);
    return rows.rows.map((r) => ({ accountId: r.account_id, amount: formatDecimalBigint(BigInt(r.amount_minor)), currency: r.currency })) as Array<{ accountId: string; amount: string; currency: string }>;
  });
}

export async function getTransactionSummary(
  pool: Pool,
  claims: TenantClaims,
  filter: { dateFrom?: string; dateTo?: string; accountIds?: string[]; direction?: string } = {}
): Promise<Array<{ date: string; amount: string; currency: string; direction: string; description: string }>> {
  if (filter.accountIds !== undefined && !filter.accountIds.every(isUuid)) throw new TenantInvalid();
  if (filter.direction !== undefined && !["INFLOW", "OUTFLOW"].includes(filter.direction)) throw new TenantInvalid();
  for (const value of [filter.dateFrom, filter.dateTo]) if (value !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new TenantInvalid();
  return withTenant(pool, claims, async (client) => {
    let query = `SELECT effective_date, amount_minor, currency, direction, description
      FROM transactions WHERE workspace_id = $1`;
    const params: unknown[] = [claims.workspaceId];
    let paramIdx = 2;
    if (filter.dateFrom) { query += ` AND effective_date >= $${paramIdx++}`; params.push(filter.dateFrom); }
    if (filter.dateTo) { query += ` AND effective_date <= $${paramIdx++}`; params.push(filter.dateTo); }
    if (filter.accountIds) {
      const placeholders = filter.accountIds.map(() => `$${paramIdx++}`).join(",");
      query += ` AND account_id IN (${placeholders})`;
      params.push(...filter.accountIds);
    }
    if (filter.direction) { query += ` AND direction = $${paramIdx++}`; params.push(filter.direction); }
    query += ` ORDER BY effective_date DESC LIMIT 500`;
    const rows = await client.query(query, params);
    return rows.rows.map((r) => ({ date: r.effective_date, amount: formatDecimalBigint(BigInt(r.amount_minor)), currency: r.currency, direction: r.direction, description: r.description })) as Array<{ date: string; amount: string; currency: string; direction: string; description: string }>;
  });
}
