import { and, asc, eq, inArray } from "drizzle-orm";
import {
  createResolveMatchCommand,
  executeCommand,
  type CommandContext,
  type CommandOutcome,
  type MatchStore,
  type ResolveMatchInput,
  type ResolveMatchResult,
  type ResolveStore,
} from "@moneo/finance";
import { createDrizzleCommandStore, type CommandStoreDb } from "./command-store.js";
import {
  accountSourceLinks,
  accounts,
  importMatchCandidates,
  sourceTransactions,
  transactionSourceLinks,
  transactions,
} from "./schema.js";

/**
 * Issue 4.11 — Drizzle match stores over the 0013 table.
 *
 * Same lookup-first semantics as the memory store: trusted hits resolve by
 * stable source keys, fuzzy lookup is a bounded indexed read on
 * (workspace, date, amount, currency) with description matching in the
 * domain layer, and every write is pair-unique so retries converge.
 * Resolution runs through `executeResolveMatch` (audited, idempotent,
 * outbox-emitting) inside the caller's `withWorkspaceTransaction`.
 */

export type MatchDb = CommandStoreDb;

export function createDrizzleMatchStore(db: MatchDb): MatchStore {
  return {
    async findAccountIdBySource(sourceAccountId) {
      const rows = await db
        .select({ accountId: accountSourceLinks.accountId })
        .from(accountSourceLinks)
        .where(eq(accountSourceLinks.sourceAccountId, sourceAccountId))
        .limit(1);
      return rows[0]?.accountId ?? null;
    },
    async createAccount(input) {
      const rows = await db
        .insert(accounts)
        .values({
          workspaceId: input.workspaceId,
          name: input.name,
          currencyCode: input.currencyCode,
        })
        .returning();
      const row = rows[0];
      if (!row) {
        throw new Error("Account insert returned no row.");
      }
      return { id: row.id };
    },
    async linkAccount(input) {
      await db
        .insert(accountSourceLinks)
        .values({
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          sourceAccountId: input.sourceAccountId,
          relationship: "PRIMARY",
        })
        .onConflictDoNothing({
          target: [accountSourceLinks.accountId, accountSourceLinks.sourceAccountId],
        });
    },
    async findTransactionIdBySource(sourceTransactionId) {
      const rows = await db
        .select({ transactionId: transactionSourceLinks.transactionId })
        .from(transactionSourceLinks)
        .where(eq(transactionSourceLinks.sourceTransactionId, sourceTransactionId))
        .limit(1);
      return rows[0]?.transactionId ?? null;
    },
    async createTransaction(input) {
      const rows = await db
        .insert(transactions)
        .values({
          workspaceId: input.workspaceId,
          accountId: input.accountId,
          status: "POSTED",
          direction: input.direction,
          amountMinor: Number(input.amountMinor),
          currencyCode: input.currencyCode,
          effectiveDate: input.effectiveDate,
          description: input.description,
        })
        .returning();
      const row = rows[0];
      if (!row) {
        throw new Error("Transaction insert returned no row.");
      }
      return { id: row.id };
    },
    async linkTransaction(input) {
      await db
        .insert(transactionSourceLinks)
        .values({
          workspaceId: input.workspaceId,
          transactionId: input.transactionId,
          sourceTransactionId: input.sourceTransactionId,
          relationship: "PRIMARY",
        })
        .onConflictDoNothing({
          target: [
            transactionSourceLinks.transactionId,
            transactionSourceLinks.sourceTransactionId,
          ],
        });
    },
    async findTrustedSource(input) {
      const candidates =
        input.externalId !== null
          ? await db
              .select({ id: sourceTransactions.id })
              .from(sourceTransactions)
              .where(
                and(
                  eq(sourceTransactions.dataSourceId, input.dataSourceId),
                  eq(sourceTransactions.externalId, input.externalId),
                ),
              )
              .limit(1)
          : input.stableSourceKey !== null
            ? await db
                .select({ id: sourceTransactions.id })
                .from(sourceTransactions)
                .where(
                  and(
                    eq(sourceTransactions.dataSourceId, input.dataSourceId),
                    eq(sourceTransactions.stableSourceKey, input.stableSourceKey),
                  ),
                )
                .limit(1)
            : [];
      const found = candidates[0];
      return found ? { sourceTransactionId: found.id } : null;
    },
    async findFuzzyTransactions(filter) {
      const rows = await db
        .select({
          transactionId: transactions.id,
          description: transactions.description,
        })
        .from(transactions)
        .where(
          and(
            eq(transactions.workspaceId, filter.workspaceId),
            eq(transactions.effectiveDate, filter.effectiveDate),
            eq(transactions.amountMinor, Number(filter.amountMinor)),
            eq(transactions.currencyCode, filter.currencyCode),
          ),
        )
        .limit(filter.limit ?? 10);
      return rows.map((row) => ({
        transactionId: row.transactionId,
        description: row.description,
      }));
    },
    async linkMerged(input) {
      const inserted = await db
        .insert(transactionSourceLinks)
        .values({
          workspaceId: input.workspaceId,
          transactionId: input.transactionId,
          sourceTransactionId: input.sourceTransactionId,
          relationship: "MERGED",
        })
        .onConflictDoNothing({
          target: [
            transactionSourceLinks.transactionId,
            transactionSourceLinks.sourceTransactionId,
          ],
        })
        .returning();
      return { created: inserted.length > 0 };
    },
    async stageCandidate(candidate) {
      const inserted = await db
        .insert(importMatchCandidates)
        .values({
          workspaceId: candidate.workspaceId,
          importId: candidate.importId,
          dataSourceId: candidate.dataSourceId,
          sourceTransactionId: candidate.sourceTransactionId,
          candidateTransactionId: candidate.candidateTransactionId,
          matchRule: candidate.matchRule,
          matchVersion: "v1",
          confidence: candidate.confidence,
          status: candidate.status,
          detail: candidate.detail,
        })
        .onConflictDoNothing({
          target: [
            importMatchCandidates.sourceTransactionId,
            importMatchCandidates.candidateTransactionId,
          ],
        })
        .returning();
      const row = inserted[0];
      if (row) {
        return { id: row.id, created: true };
      }
      const existing = await db
        .select({ id: importMatchCandidates.id })
        .from(importMatchCandidates)
        .where(
          and(
            eq(importMatchCandidates.sourceTransactionId, candidate.sourceTransactionId),
            eq(importMatchCandidates.candidateTransactionId, candidate.candidateTransactionId),
          ),
        )
        .limit(1);
      const found = existing[0];
      if (!found) {
        throw new Error("Candidate insert returned no row.");
      }
      return { id: found.id, created: false };
    },
  };
}

export function createDrizzleResolveStore(db: MatchDb): ResolveStore {
  const match = createDrizzleMatchStore(db);
  return {
    ...match,
    async findCandidate(workspaceId, candidateId) {
      const rows = await db
        .select()
        .from(importMatchCandidates)
        .where(
          and(
            eq(importMatchCandidates.workspaceId, workspaceId),
            eq(importMatchCandidates.id, candidateId),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) {
        return null;
      }
      return {
        id: row.id,
        status: row.status as "pending" | "linked" | "distinct",
        importId: row.importId,
        dataSourceId: row.dataSourceId,
        sourceTransactionId: row.sourceTransactionId,
        candidateTransactionId: row.candidateTransactionId,
        detail: row.detail,
      };
    },
    async findCanonicalTransaction(workspaceId, transactionId) {
      const rows = await db
        .select({ id: transactions.id })
        .from(transactions)
        .where(and(eq(transactions.workspaceId, workspaceId), eq(transactions.id, transactionId)))
        .limit(1);
      return rows[0] ?? null;
    },
    async markCandidate(workspaceId, candidateId, status) {
      await db
        .update(importMatchCandidates)
        .set({ status, decidedAt: new Date() })
        .where(
          and(
            eq(importMatchCandidates.workspaceId, workspaceId),
            eq(importMatchCandidates.id, candidateId),
          ),
        );
    },
  };
}

export async function executeResolveMatch(
  db: MatchDb,
  ctx: CommandContext,
  input: ResolveMatchInput,
): Promise<CommandOutcome<ResolveMatchResult>> {
  return executeCommand(
    createResolveMatchCommand(createDrizzleResolveStore(db)),
    ctx,
    input,
    createDrizzleCommandStore(db),
  );
}

export interface PendingCandidateView {
  id: string;
  importId: string;
  sourceTransactionId: string;
  candidateTransactionId: string;
  matchRule: string;
  candidateDate: string;
  candidateDescription: string;
  candidateAmountMinor: string;
  candidateCurrency: string;
  stagedDescription: string;
  stagedDate: string;
  stagedAmountMinor: string;
  stagedCurrency: string;
  stagedDirection: string;
  createdAt: Date;
}

/** Pending review rows for one import, with both sides' descriptions. */
export async function listPendingCandidates(
  db: MatchDb,
  workspaceId: string,
  importId: string,
): Promise<PendingCandidateView[]> {
  const rows = await db
    .select()
    .from(importMatchCandidates)
    .where(
      and(
        eq(importMatchCandidates.workspaceId, workspaceId),
        eq(importMatchCandidates.importId, importId),
        eq(importMatchCandidates.status, "pending"),
      ),
    )
    .orderBy(asc(importMatchCandidates.createdAt), asc(importMatchCandidates.id));
  if (rows.length === 0) {
    return [];
  }
  const txnIds = [...new Set(rows.map((r) => r.candidateTransactionId))];
  const txns = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.workspaceId, workspaceId), inArray(transactions.id, txnIds)));
  const byId = new Map(txns.map((t) => [t.id, t]));
  return rows.map((row) => {
    const txn = byId.get(row.candidateTransactionId);
    const detail = row.detail as {
      description?: unknown;
      date?: unknown;
      amountMinor?: unknown;
      currencyCode?: unknown;
      direction?: unknown;
    };
    const text = (value: unknown): string => (typeof value === "string" ? value : "");
    const direction = detail.direction === "credit" ? "credit" : "debit";
    return {
      id: row.id,
      importId: row.importId,
      sourceTransactionId: row.sourceTransactionId,
      candidateTransactionId: row.candidateTransactionId,
      matchRule: row.matchRule,
      candidateDate: txn?.effectiveDate ?? "",
      candidateDescription: txn?.description ?? "",
      candidateAmountMinor: txn ? String(txn.amountMinor) : "",
      candidateCurrency: txn?.currencyCode ?? "",
      stagedDescription: text(detail.description),
      stagedDate: text(detail.date),
      stagedAmountMinor: text(detail.amountMinor),
      stagedCurrency: text(detail.currencyCode),
      stagedDirection: direction,
      createdAt: row.createdAt,
    };
  });
}
