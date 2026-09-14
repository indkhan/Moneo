import { and, asc, eq, gte, ilike, inArray, lte, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import type { Db } from "./client.js";
import { DomainError } from "@moneo/shared/problem";
import { frozenTransactionSelections, transactions } from "./schema.js";
import type * as schema from "./schema.js";

type WorkspaceDb = Db | PgliteDatabase<typeof schema> | NodePgDatabase<typeof schema>;

/** The serializable filter saved with a view or resolved into a frozen selection. */
export interface TransactionWorkspaceFilter {
  q?: string;
  accountIds?: string[];
  directions?: ("credit" | "debit")[];
  dateFrom?: string;
  dateTo?: string;
  categoryIds?: string[];
  tagNames?: string[];
  counterpartyIds?: string[];
  excludedFromAnalytics?: boolean;
}

export interface FrozenTransactionItem {
  id: string;
  version: number;
}

export interface FrozenTransactionSelection {
  id: string;
  workspaceId: string;
  items: FrozenTransactionItem[];
  expiresAt: Date;
}

function conditionsFor(workspaceId: string, filter: TransactionWorkspaceFilter) {
  const conditions = [eq(transactions.workspaceId, workspaceId)];
  if (filter.q?.trim())
    conditions.push(
      ilike(transactions.description, `%${filter.q.trim().replace(/[\\%_]/g, "\\$&")}%`),
    );
  if (filter.accountIds?.length)
    conditions.push(inArray(transactions.accountId, [...new Set(filter.accountIds)]));
  if (filter.directions?.length)
    conditions.push(inArray(transactions.direction, [...new Set(filter.directions)]));
  if (filter.dateFrom) conditions.push(gte(transactions.effectiveDate, filter.dateFrom));
  if (filter.dateTo) conditions.push(lte(transactions.effectiveDate, filter.dateTo));
  if (filter.categoryIds?.length)
    conditions.push(inArray(transactions.categoryId, [...new Set(filter.categoryIds)]));
  for (const name of filter.tagNames ?? [])
    conditions.push(
      sql`exists (select 1 from transaction_tags tt join tags tag on tag.id=tt.tag_id and tag.workspace_id=tt.workspace_id where tt.workspace_id=${workspaceId} and tt.transaction_id=${transactions.id} and tag.name=${name})`,
    );
  if (filter.counterpartyIds?.length)
    conditions.push(inArray(transactions.counterpartyId, [...new Set(filter.counterpartyIds)]));
  if (filter.excludedFromAnalytics !== undefined)
    conditions.push(eq(transactions.excludedFromAnalytics, filter.excludedFromAnalytics));
  return conditions;
}

/** Resolve once. Future inserts and changed filters cannot change this target set. */
export async function createFrozenTransactionSelection(
  db: WorkspaceDb,
  workspaceId: string,
  filter: TransactionWorkspaceFilter,
  explicitIds?: string[],
): Promise<FrozenTransactionSelection> {
  const conditions = conditionsFor(workspaceId, filter);
  if (explicitIds !== undefined) {
    if (explicitIds.length === 0) return { id: "", workspaceId, items: [], expiresAt: new Date() };
    conditions.push(inArray(transactions.id, [...new Set(explicitIds)]));
  }
  const items = await db
    .select({ id: transactions.id, version: transactions.version })
    .from(transactions)
    .where(and(...conditions))
    .orderBy(asc(transactions.id))
    .limit(10_001);
  if (items.length > 10_000)
    throw new DomainError("VALIDATION_FAILED", {
      detail:
        "Select at most 10,000 transactions. Narrow the filters before applying a bulk change.",
    });
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const [created] = await db
    .insert(frozenTransactionSelections)
    .values({
      workspaceId,
      queryDefinition: filter as Record<string, unknown>,
      transactionIds: items.map((item) => item.id),
      transactionVersions: items.map((item) => ({ id: item.id, version: item.version })),
      expiresAt,
    })
    .returning();
  if (!created) throw new Error("Failed to create frozen transaction selection.");
  return { id: created.id, workspaceId, items, expiresAt };
}

export async function getFrozenTransactionSelection(
  db: WorkspaceDb,
  workspaceId: string,
  selectionId: string,
): Promise<FrozenTransactionSelection | null> {
  const [row] = await db
    .select()
    .from(frozenTransactionSelections)
    .where(
      and(
        eq(frozenTransactionSelections.workspaceId, workspaceId),
        eq(frozenTransactionSelections.id, selectionId),
      ),
    )
    .limit(1);
  if (!row || row.expiresAt <= new Date()) return null;
  const items = row.transactionVersions.length
    ? row.transactionVersions
    : row.transactionIds.map((id) => ({ id, version: 0 }));
  return { id: row.id, workspaceId: row.workspaceId, items, expiresAt: row.expiresAt };
}

export async function countTransactionWorkspaceFilter(
  db: WorkspaceDb,
  workspaceId: string,
  filter: TransactionWorkspaceFilter,
) {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(transactions)
    .where(and(...conditionsFor(workspaceId, filter)));
  return row?.count ?? 0;
}
