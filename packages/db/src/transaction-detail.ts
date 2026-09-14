import { and, asc, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import type { Db } from "./client.js";
import {
  accounts,
  categories,
  counterparties,
  dataSources,
  imports,
  sourceTransactionObservations,
  sourceTransactions,
  tags,
  transactionSourceLinks,
  transactions,
  transactionTags,
  type Transaction,
} from "./schema.js";
import type * as schema from "./schema.js";

/**
 * Issue 4.8 — transaction detail query (canonical fields + provenance).
 * Issue 5.5 extends it with the live correction state (category,
 * counterparty, tags) the drawer edits.
 *
 * One tenant-scoped read joining the canonical row to its source history:
 * every `PRIMARY`/`PENDING_PREDECESSOR`/`MERGED` link, each linked source
 * transaction's observations oldest-first, and each observation's import
 * (file name) and data-source name. Raw payloads are returned verbatim —
 * "View original" shows what the source actually said, never a
 * re-normalized copy. Returns null for unknown or foreign ids (the handler
 * answers 404; RLS would hide them anyway).
 */

export type TransactionDetailDb =
  Db | PgliteDatabase<typeof schema> | NodePgDatabase<typeof schema>;

export interface DetailSource {
  sourceTransactionId: string;
  relationship: string;
  dataSourceId: string;
  dataSourceName: string;
  importId: string | null;
  fileName: string | null;
  observedAt: Date;
  rawPayload: Record<string, unknown>;
}

export interface TransactionDetail {
  transaction: Transaction;
  accountName: string;
  /** Live correction state for the drawer (Issue 5.5); nulls mean unset. */
  category: { id: string; name: string } | null;
  counterparty: { id: string; displayName: string } | null;
  tags: string[];
  sources: DetailSource[];
}

export async function getTransactionDetail(
  db: TransactionDetailDb,
  workspaceId: string,
  transactionId: string,
): Promise<TransactionDetail | null> {
  const txnRows = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.workspaceId, workspaceId), eq(transactions.id, transactionId)))
    .limit(1);
  const transaction = txnRows[0];
  if (!transaction) {
    return null;
  }
  const accountRows = await db
    .select({ name: accounts.name })
    .from(accounts)
    .where(and(eq(accounts.workspaceId, workspaceId), eq(accounts.id, transaction.accountId)))
    .limit(1);
  const accountName = accountRows[0]?.name ?? "Unknown account";

  const categoryRows =
    transaction.categoryId === null
      ? []
      : await db
          .select({ id: categories.id, name: categories.name })
          .from(categories)
          .where(
            and(eq(categories.workspaceId, workspaceId), eq(categories.id, transaction.categoryId)),
          )
          .limit(1);
  const counterpartyRows =
    transaction.counterpartyId === null
      ? []
      : await db
          .select({ id: counterparties.id, displayName: counterparties.displayName })
          .from(counterparties)
          .where(
            and(
              eq(counterparties.workspaceId, workspaceId),
              eq(counterparties.id, transaction.counterpartyId),
            ),
          )
          .limit(1);
  const tagRows = await db
    .select({ name: tags.name })
    .from(transactionTags)
    .innerJoin(tags, eq(transactionTags.tagId, tags.id))
    .where(
      and(
        eq(transactionTags.workspaceId, workspaceId),
        eq(transactionTags.transactionId, transactionId),
      ),
    )
    .orderBy(asc(tags.name));
  const correction = {
    category: categoryRows[0] ?? null,
    counterparty: counterpartyRows[0] ?? null,
    tags: tagRows.map((r) => r.name),
  };

  const links = await db
    .select()
    .from(transactionSourceLinks)
    .where(
      and(
        eq(transactionSourceLinks.workspaceId, workspaceId),
        eq(transactionSourceLinks.transactionId, transactionId),
      ),
    )
    .orderBy(
      asc(transactionSourceLinks.createdAt),
      asc(transactionSourceLinks.sourceTransactionId),
    );
  if (links.length === 0) {
    return { transaction, accountName, ...correction, sources: [] };
  }

  const sourceIds = [...new Set(links.map((l) => l.sourceTransactionId))];
  const sourceRows = await db
    .select()
    .from(sourceTransactions)
    .where(
      and(
        eq(sourceTransactions.workspaceId, workspaceId),
        inArray(sourceTransactions.id, sourceIds),
      ),
    );
  const sourceById = new Map(sourceRows.map((s) => [s.id, s]));
  const dataSourceIds = [...new Set(sourceRows.map((s) => s.dataSourceId))];
  const dataSourceRows =
    dataSourceIds.length > 0
      ? await db
          .select()
          .from(dataSources)
          .where(
            and(eq(dataSources.workspaceId, workspaceId), inArray(dataSources.id, dataSourceIds)),
          )
      : [];
  const dataSourceById = new Map(dataSourceRows.map((d) => [d.id, d]));

  const observationRows = await db
    .select()
    .from(sourceTransactionObservations)
    .where(
      and(
        eq(sourceTransactionObservations.workspaceId, workspaceId),
        inArray(sourceTransactionObservations.sourceTransactionId, sourceIds),
      ),
    )
    .orderBy(
      asc(sourceTransactionObservations.sourceTransactionId),
      asc(sourceTransactionObservations.observedAt),
      asc(sourceTransactionObservations.id),
    );
  const importIds = [
    ...new Set(observationRows.map((o) => o.importId).filter((id) => id !== null)),
  ];
  const importRows =
    importIds.length > 0
      ? await db
          .select()
          .from(imports)
          .where(and(eq(imports.workspaceId, workspaceId), inArray(imports.id, importIds)))
      : [];
  const importById = new Map(importRows.map((i) => [i.id, i]));

  const sources: DetailSource[] = [];
  for (const link of links) {
    const source = sourceById.get(link.sourceTransactionId);
    if (!source) {
      continue;
    }
    const dataSource = dataSourceById.get(source.dataSourceId);
    const observations = observationRows.filter((o) => o.sourceTransactionId === source.id);
    if (observations.length === 0) {
      sources.push({
        sourceTransactionId: source.id,
        relationship: link.relationship,
        dataSourceId: source.dataSourceId,
        dataSourceName: dataSource?.name ?? "Unknown source",
        importId: null,
        fileName: null,
        observedAt: source.firstSeenAt,
        rawPayload: {},
      });
      continue;
    }
    for (const observation of observations) {
      const imp = observation.importId ? (importById.get(observation.importId) ?? null) : null;
      sources.push({
        sourceTransactionId: source.id,
        relationship: link.relationship,
        dataSourceId: source.dataSourceId,
        dataSourceName: dataSource?.name ?? "Unknown source",
        importId: observation.importId,
        fileName: imp?.fileName ?? null,
        observedAt: observation.observedAt,
        rawPayload: observation.rawPayload,
      });
    }
  }
  return { transaction, accountName, ...correction, sources };
}
