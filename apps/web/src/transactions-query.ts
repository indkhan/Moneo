// E03-S06 shared transaction reads: one module for HTTP, UI, and future
// AI/artifact adapters. Scoped pagination/filter/sort plus totals computed
// from the SAME predicates, so UI totals can never drift from query
// semantics. Exact minor-unit sums via SQL SUM (numeric) formatted as
// decimal strings; BigInt only, never floats. Every query scopes by
// explicit workspace predicates inside withTenant (RLS defense in depth).

import { formatDecimalBigint } from "./money.ts";
import { TenantInvalid, withTenant, type TenantClaims } from "./tenancy.ts";
import type { Pool } from "pg";

export type TxKindFilter = "imported" | "manual" | "all";

export type TxListFilter = {
  workspaceId: string;
  kind: TxKindFilter;
  accountId?: string;
  categoryId?: string;
  uncategorized?: boolean;
  tagId?: string;
  direction?: "INFLOW" | "OUTFLOW";
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  sort?: "date_desc" | "date_asc";
  limit?: number;
  offset?: number;
};

export type TxListItem = {
  workspaceId: string;
  kind: "imported" | "manual";
  id: string;
  accountId: string;
  amountMinor: string;
  currency: string;
  direction: "INFLOW" | "OUTFLOW";
  effectiveDate: string;
  description: string;
  categoryId: string | null;
  tagIds: string[];
  version: string;
};

export type TxCurrencyTotals = { currency: string; count: string; inflowMinor: string; outflowMinor: string };

// Totals group by currency: minor-unit sums across mixed currencies would be
// meaningless, so each currency carries its own exact count/inflow/outflow.
export type TxTotals = { count: string; byCurrency: TxCurrencyTotals[] };

export type TxListResult = { items: TxListItem[]; totals: TxTotals; limit: number; offset: number };

export type TxEvidence = {
  workspaceId: string;
  kind: "imported" | "manual";
  id: string;
  source:
    | {
        kind: "imported";
        importId: string;
        fileName: string;
        importRowNo: number;
        observationId: string;
        linkStatus: string;
        matchReason: string | null;
        matchedTransactionId: string | null;
      }
    | { kind: "manual"; actorId: string; reference: string | null };
  audit: { id: string; action: string; createdAt: string; operationId: string | null; compensatingOperationId: string | null }[];
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function fail(): never {
  throw new TenantInvalid();
}

function fmtDate(value: string | Date): string {
  if (value instanceof Date) {
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}-${String(value.getUTCDate()).padStart(2, "0")}`;
  }
  return value;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function validateListFilter(raw: unknown): TxListFilter {
  if (typeof raw !== "object" || raw === null) fail();
  const v = raw as Record<string, unknown>;
  const workspaceId = v.workspaceId;
  if (typeof workspaceId !== "string" || !UUID_RE.test(workspaceId)) fail();
  const kind = v.kind === undefined ? "all" : v.kind;
  if (kind !== "imported" && kind !== "manual" && kind !== "all") fail();
  const filter: TxListFilter = { workspaceId: workspaceId as string, kind: kind as TxKindFilter };
  if (v.accountId !== undefined) {
    if (typeof v.accountId !== "string" || !UUID_RE.test(v.accountId)) fail();
    filter.accountId = v.accountId as string;
  }
  if (v.categoryId !== undefined) {
    if (typeof v.categoryId !== "string" || !UUID_RE.test(v.categoryId)) fail();
    filter.categoryId = v.categoryId as string;
  }
  if (v.uncategorized !== undefined) {
    if (v.uncategorized !== true && v.uncategorized !== "1" && v.uncategorized !== false && v.uncategorized !== "0") fail();
    filter.uncategorized = v.uncategorized === true || v.uncategorized === "1";
  }
  if (v.tagId !== undefined) {
    if (typeof v.tagId !== "string" || !UUID_RE.test(v.tagId)) fail();
    filter.tagId = v.tagId as string;
  }
  if (v.direction !== undefined) {
    if (v.direction !== "INFLOW" && v.direction !== "OUTFLOW") fail();
    filter.direction = v.direction as "INFLOW" | "OUTFLOW";
  }
  if (v.dateFrom !== undefined) {
    if (typeof v.dateFrom !== "string" || !DATE_RE.test(v.dateFrom)) fail();
    filter.dateFrom = v.dateFrom as string;
  }
  if (v.dateTo !== undefined) {
    if (typeof v.dateTo !== "string" || !DATE_RE.test(v.dateTo)) fail();
    filter.dateTo = v.dateTo as string;
  }
  if (v.search !== undefined) {
    if (typeof v.search !== "string" || v.search.length < 1 || v.search.length > 100) fail();
    filter.search = v.search as string;
  }
  if (v.sort !== undefined) {
    if (v.sort !== "date_desc" && v.sort !== "date_asc") fail();
    filter.sort = v.sort as "date_desc" | "date_asc";
  }
  if (v.limit !== undefined) {
    const n = typeof v.limit === "string" ? Number(v.limit) : v.limit;
    if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > 100) fail();
    filter.limit = n as number;
  }
  if (v.offset !== undefined) {
    const n = typeof v.offset === "string" ? Number(v.offset) : v.offset;
    if (!Number.isInteger(n) || (n as number) < 0 || (n as number) > 1_000_000) fail();
    filter.offset = n as number;
  }
  if (filter.categoryId !== undefined && filter.uncategorized) fail();
  return filter;
}

type Side = "imported" | "manual";

function buildWhere(filter: TxListFilter, side: Side, startIdx: number): { clause: string; params: unknown[] } {
  const parts: string[] = ["workspace_id = $1"];
  const params: unknown[] = [];
  // params[0] is always the workspace id; placeholder numbering starts at $2.
  void startIdx;
  let idx = 2;
  const push = (value: unknown): string => {
    params.push(value);
    return `$${idx++}`;
  };
  params.push(filter.workspaceId);
  if (filter.accountId !== undefined) parts.push(`account_id = ${push(filter.accountId)}`);
  if (filter.categoryId !== undefined) parts.push(`category_id = ${push(filter.categoryId)}`);
  if (filter.uncategorized) parts.push(`category_id IS NULL`);
  if (filter.direction !== undefined) parts.push(`direction = ${push(filter.direction)}`);
  if (filter.dateFrom !== undefined) parts.push(`effective_date >= ${push(filter.dateFrom)}`);
  if (filter.dateTo !== undefined) parts.push(`effective_date <= ${push(filter.dateTo)}`);
  if (filter.search !== undefined) {
    parts.push(`description ILIKE ${push(`%${escapeLike(filter.search)}%`)} ESCAPE '\\'`);
  }
  if (filter.tagId !== undefined) {
    if (side === "imported") {
      parts.push(`EXISTS (SELECT 1 FROM transaction_tags tt WHERE tt.workspace_id = transactions.workspace_id AND tt.transaction_id = transactions.id AND tt.tag_id = ${push(filter.tagId)})`);
    } else {
      // Tags attach to imported transactions only (S05 documented
      // limitation): a tag filter matches zero manual rows, never an error.
      parts.push(`1 = 0`);
    }
  }
  return { clause: parts.join(" AND "), params };
}

type RawRow = {
  workspace_id: string;
  id: string;
  account_id: string;
  amount_minor: string;
  currency: string;
  direction: string;
  effective_date: string | Date;
  description: string;
  category_id: string | null;
  version: string;
};

export async function listTransactions(pool: Pool, claims: TenantClaims, raw: unknown): Promise<TxListResult> {
  const filter = validateListFilter(raw);
  if (filter.workspaceId !== claims.workspaceId) throw new TenantInvalid();
  const limit = filter.limit ?? 50;
  const offset = filter.offset ?? 0;
  const dir = filter.sort === "date_asc" ? "ASC" : "DESC";
  return withTenant(pool, claims, async (client) => {
    const sides: Side[] = filter.kind === "all" ? ["imported", "manual"] : [filter.kind];
    const perSide = limit + offset;
    const merged: (RawRow & { kind: Side })[] = [];
    const byCurrency = new Map<string, { count: bigint; inflow: bigint; outflow: bigint }>();
    let count = 0n;
    for (const side of sides) {
      const table = side === "imported" ? "transactions" : "manual_transactions";
      const { clause, params } = buildWhere(filter, side, 2);
      const rows = await client.query(
        `SELECT workspace_id, id, account_id, amount_minor, currency, direction, effective_date, description, category_id, version FROM ${table} WHERE ${clause} ORDER BY effective_date ${dir}, id ${dir} LIMIT $l OFFSET $o`.replace("$l", `$${params.length + 1}`).replace("$o", `$${params.length + 2}`),
        [...params, perSide, 0],
      );
      for (const r of rows.rows as RawRow[]) merged.push({ ...r, kind: side });
      const agg = await client.query(
        `SELECT currency, COUNT(*) AS c, COALESCE(SUM(CASE WHEN direction = 'INFLOW' THEN amount_minor ELSE 0 END), 0) AS inflow, COALESCE(SUM(CASE WHEN direction = 'OUTFLOW' THEN amount_minor ELSE 0 END), 0) AS outflow FROM ${table} WHERE ${clause} GROUP BY currency`,
        params,
      );
      for (const a of agg.rows as { currency: string; c: string; inflow: string; outflow: string }[]) {
        const cur = a.currency.trim();
        const slot = byCurrency.get(cur) ?? { count: 0n, inflow: 0n, outflow: 0n };
        slot.count += BigInt(a.c);
        slot.inflow += BigInt(a.inflow);
        slot.outflow += BigInt(a.outflow);
        byCurrency.set(cur, slot);
        count += BigInt(a.c);
      }
    }
    merged.sort((a, b) => {
      const da = fmtDate(a.effective_date);
      const db = fmtDate(b.effective_date);
      if (da !== db) return dir === "ASC" ? (da < db ? -1 : 1) : da < db ? 1 : -1;
      return dir === "ASC" ? (a.id < b.id ? -1 : 1) : a.id < b.id ? 1 : -1;
    });
    const page = merged.slice(offset, offset + limit);
    const tagIdsByTx = new Map<string, string[]>();
    const importedIds = page.filter((r) => r.kind === "imported").map((r) => r.id);
    if (importedIds.length > 0) {
      const tags = await client.query("SELECT transaction_id, tag_id FROM transaction_tags WHERE workspace_id = $1 AND transaction_id = ANY($2)", [claims.workspaceId, importedIds]);
      for (const t of tags.rows as { transaction_id: string; tag_id: string }[]) {
        const list = tagIdsByTx.get(t.transaction_id) ?? [];
        list.push(t.tag_id);
        tagIdsByTx.set(t.transaction_id, list);
      }
      for (const list of tagIdsByTx.values()) list.sort();
    }
    const items: TxListItem[] = page.map((r) => ({
      workspaceId: r.workspace_id,
      kind: r.kind,
      id: r.id,
      accountId: r.account_id,
      amountMinor: formatDecimalBigint(BigInt(r.amount_minor) < 0n ? -BigInt(r.amount_minor) : BigInt(r.amount_minor)),
      currency: r.currency.trim(),
      direction: r.direction as "INFLOW" | "OUTFLOW",
      effectiveDate: fmtDate(r.effective_date),
      description: r.description,
      categoryId: r.category_id,
      tagIds: tagIdsByTx.get(r.id) ?? [],
      version: formatDecimalBigint(BigInt(r.version)),
    }));
    return {
      items,
      totals: {
        count: count.toString(10),
        byCurrency: [...byCurrency.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([currency, t]) => ({ currency, count: t.count.toString(10), inflowMinor: t.inflow.toString(10), outflowMinor: t.outflow.toString(10) })),
      },
      limit,
      offset,
    };
  });
}

export async function getTransactionEvidence(pool: Pool, claims: TenantClaims, kind: "imported" | "manual", id: string): Promise<TxEvidence | null> {
  if (!UUID_RE.test(id)) return null;
  return withTenant(pool, claims, async (client) => {
    const table = kind === "imported" ? "transactions" : "manual_transactions";
    const found = await client.query(`SELECT id FROM ${table} WHERE workspace_id = $1 AND id = $2`, [claims.workspaceId, id]);
    if ((found.rowCount ?? 0) === 0) return null;
    let source: TxEvidence["source"];
    if (kind === "imported") {
      const tx = await client.query("SELECT import_id, import_row_no, observation_id FROM transactions WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, id]);
      const t = tx.rows[0] as { import_id: string; import_row_no: number; observation_id: string };
      const link = await client.query("SELECT target_transaction_id, status, match_reason FROM source_links WHERE workspace_id = $1 AND import_id = $2 AND import_row_no = $3", [claims.workspaceId, t.import_id, t.import_row_no]);
      const l = (link.rows[0] as { target_transaction_id: string | null; status: string; match_reason: string | null } | undefined) ?? null;
      const imp = await client.query("SELECT file_name FROM imports WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, t.import_id]);
      source = {
        kind: "imported",
        importId: t.import_id,
        fileName: ((imp.rows[0] as { file_name: string } | undefined)?.file_name ?? "").slice(0, 200),
        importRowNo: t.import_row_no,
        observationId: t.observation_id,
        linkStatus: l?.status ?? "UNKNOWN",
        matchReason: l?.match_reason ?? null,
        matchedTransactionId: l?.target_transaction_id ?? null,
      };
    } else {
      const m = await client.query("SELECT actor_id, reference FROM manual_transactions WHERE workspace_id = $1 AND id = $2", [claims.workspaceId, id]);
      const row = m.rows[0] as { actor_id: string; reference: string | null };
      source = { kind: "manual", actorId: row.actor_id, reference: row.reference };
    }
    const entityType = kind === "imported" ? "transaction" : "manual_transaction";
    const audit = await client.query("SELECT id, action, created_at, operation_id, compensating_operation_id FROM audit_events WHERE workspace_id = $1 AND entity_type = $2 AND entity_id = $3 ORDER BY created_at", [claims.workspaceId, entityType, id]);
    return {
      workspaceId: claims.workspaceId,
      kind,
      id,
      source,
      audit: (audit.rows as { id: string; action: string; created_at: string; operation_id: string | null; compensating_operation_id: string | null }[]).map((a) => ({
        id: a.id,
        action: a.action,
        createdAt: a.created_at,
        operationId: a.operation_id,
        compensatingOperationId: a.compensating_operation_id,
      })),
    };
  });
}
