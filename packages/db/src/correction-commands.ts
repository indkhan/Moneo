import { and, asc, eq, inArray } from "drizzle-orm";
import {
  createAddTagsCommand,
  createExcludeFromAnalyticsCommand,
  createRemoveTagsCommand,
  createSetCategoryCommand,
  createSetCounterpartyCommand,
  createSetNoteCommand,
  executeCommand,
  type AddTagsInput,
  type CommandContext,
  type CommandOutcome,
  type CorrectionData,
  type CorrectionPatch,
  type ExcludeFromAnalyticsInput,
  type ExcludeFromAnalyticsResult,
  type RemoveTagsInput,
  type SetCategoryInput,
  type SetCategoryResult,
  type SetCounterpartyInput,
  type SetCounterpartyResult,
  type SetNoteInput,
  type SetNoteResult,
  type TagsResult,
} from "@moneo/finance";
import { createDrizzleCommandStore, type CommandStoreDb } from "./command-store.js";
import {
  categories,
  counterparties,
  tags,
  transactions,
  transactionTags,
} from "./schema.js";

/**
 * Issue 5.3 — Drizzle wiring for transaction correction commands.
 *
 * Each executor runs inside the caller's `withWorkspaceTransaction`, so the
 * guarded version bump, tag-link writes, audit row, and outbox event commit
 * atomically. Tenant safety comes from workspace-scoped reads: a foreign
 * transaction/category/counterparty simply loads as null and the pure
 * domain layer fails closed (FORBIDDEN), exactly like Issue 4.12 manual
 * commands. `transactions.category_id` / `counterparty_id` stay FK-less
 * UUIDs: a bare FK would check id existence without the workspace boundary,
 * so ownership is enforced here instead.
 */

/** Shared workspace-scoped reads/writes behind every correction command (Issue 5.4 reuses it for undo). */
export function correctionDataOver(db: CommandStoreDb): CorrectionData {
  return {
    async findTransaction(workspaceId, transactionId) {
      const rows = await db
        .select({
          id: transactions.id,
          version: transactions.version,
          categoryId: transactions.categoryId,
          counterpartyId: transactions.counterpartyId,
          note: transactions.note,
          excludedFromAnalytics: transactions.excludedFromAnalytics,
        })
        .from(transactions)
        .where(and(eq(transactions.workspaceId, workspaceId), eq(transactions.id, transactionId)))
        .limit(1);
      return rows[0] ?? null;
    },
    async findCategory(workspaceId, categoryId) {
      const rows = await db
        .select({ id: categories.id, archivedAt: categories.archivedAt })
        .from(categories)
        .where(and(eq(categories.workspaceId, workspaceId), eq(categories.id, categoryId)))
        .limit(1);
      return rows[0] ?? null;
    },
    async findCounterparty(workspaceId, counterpartyId) {
      const rows = await db
        .select({ id: counterparties.id })
        .from(counterparties)
        .where(
          and(
            eq(counterparties.workspaceId, workspaceId),
            eq(counterparties.id, counterpartyId),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },
    async findOrCreateCounterpartyByName(workspaceId, normalizedName, displayName) {
      await db
        .insert(counterparties)
        .values({ workspaceId, normalizedName, displayName })
        .onConflictDoNothing({
          target: [counterparties.workspaceId, counterparties.normalizedName],
        });
      const rows = await db
        .select({ id: counterparties.id })
        .from(counterparties)
        .where(
          and(
            eq(counterparties.workspaceId, workspaceId),
            eq(counterparties.normalizedName, normalizedName),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) {
        throw new Error("Counterparty upsert returned no row.");
      }
      return { id: row.id };
    },
    async findOrCreateTag(workspaceId, name) {
      await db
        .insert(tags)
        .values({ workspaceId, name })
        .onConflictDoNothing({ target: [tags.workspaceId, tags.name] });
      const rows = await db
        .select({ id: tags.id })
        .from(tags)
        .where(and(eq(tags.workspaceId, workspaceId), eq(tags.name, name)))
        .limit(1);
      const row = rows[0];
      if (!row) {
        throw new Error("Tag upsert returned no row.");
      }
      return { id: row.id };
    },
    async listTransactionTagNames(workspaceId, transactionId) {
      const rows = await db
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
      return rows.map((r) => r.name);
    },
    async addTagLinks(workspaceId, transactionId, tagIds) {
      for (const tagId of tagIds) {
        await db
          .insert(transactionTags)
          .values({ workspaceId, transactionId, tagId })
          .onConflictDoNothing();
      }
    },
    async removeTagLinks(workspaceId, transactionId, tagIds) {
      if (tagIds.length === 0) {
        return;
      }
      await db
        .delete(transactionTags)
        .where(
          and(
            eq(transactionTags.workspaceId, workspaceId),
            eq(transactionTags.transactionId, transactionId),
            inArray(transactionTags.tagId, tagIds),
          ),
        );
    },
    async replaceTagLinks(workspaceId, transactionId, tagIds) {
      await db
        .delete(transactionTags)
        .where(
          and(
            eq(transactionTags.workspaceId, workspaceId),
            eq(transactionTags.transactionId, transactionId),
          ),
        );
      for (const tagId of tagIds) {
        await db
          .insert(transactionTags)
          .values({ workspaceId, transactionId, tagId })
          .onConflictDoNothing();
      }
    },
    async applyCorrection(workspaceId, transactionId, patch: CorrectionPatch, loadedVersion) {
      const set: Partial<typeof transactions.$inferInsert> & { updatedAt: Date } = {
        version: loadedVersion + 1,
        updatedAt: new Date(),
      };
      if (patch.categoryId !== undefined) {
        set.categoryId = patch.categoryId;
      }
      if (patch.counterpartyId !== undefined) {
        set.counterpartyId = patch.counterpartyId;
      }
      if (patch.note !== undefined) {
        set.note = patch.note;
      }
      if (patch.excludedFromAnalytics !== undefined) {
        set.excludedFromAnalytics = patch.excludedFromAnalytics;
      }
      const rows = await db
        .update(transactions)
        .set(set)
        .where(
          and(
            eq(transactions.workspaceId, workspaceId),
            eq(transactions.id, transactionId),
            eq(transactions.version, loadedVersion),
          ),
        )
        .returning();
      const row = rows[0];
      return row ? { version: row.version } : null;
    },
  };
}

export async function executeSetCategory(
  db: CommandStoreDb,
  ctx: CommandContext,
  input: SetCategoryInput,
): Promise<CommandOutcome<SetCategoryResult>> {
  return executeCommand(
    createSetCategoryCommand(correctionDataOver(db)),
    ctx,
    input,
    createDrizzleCommandStore(db),
  );
}

export async function executeSetCounterparty(
  db: CommandStoreDb,
  ctx: CommandContext,
  input: SetCounterpartyInput,
): Promise<CommandOutcome<SetCounterpartyResult>> {
  return executeCommand(
    createSetCounterpartyCommand(correctionDataOver(db)),
    ctx,
    input,
    createDrizzleCommandStore(db),
  );
}

export async function executeAddTags(
  db: CommandStoreDb,
  ctx: CommandContext,
  input: AddTagsInput,
): Promise<CommandOutcome<TagsResult>> {
  return executeCommand(
    createAddTagsCommand(correctionDataOver(db)),
    ctx,
    input,
    createDrizzleCommandStore(db),
  );
}

export async function executeRemoveTags(
  db: CommandStoreDb,
  ctx: CommandContext,
  input: RemoveTagsInput,
): Promise<CommandOutcome<TagsResult>> {
  return executeCommand(
    createRemoveTagsCommand(correctionDataOver(db)),
    ctx,
    input,
    createDrizzleCommandStore(db),
  );
}

export async function executeSetNote(
  db: CommandStoreDb,
  ctx: CommandContext,
  input: SetNoteInput,
): Promise<CommandOutcome<SetNoteResult>> {
  return executeCommand(
    createSetNoteCommand(correctionDataOver(db)),
    ctx,
    input,
    createDrizzleCommandStore(db),
  );
}

export async function executeExcludeFromAnalytics(
  db: CommandStoreDb,
  ctx: CommandContext,
  input: ExcludeFromAnalyticsInput,
): Promise<CommandOutcome<ExcludeFromAnalyticsResult>> {
  return executeCommand(
    createExcludeFromAnalyticsCommand(correctionDataOver(db)),
    ctx,
    input,
    createDrizzleCommandStore(db),
  );
}
