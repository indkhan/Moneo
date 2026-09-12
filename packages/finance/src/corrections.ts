import { CommandError, type CommandDefinition, type CommandMutation } from "./commands.js";

/**
 * Issue 5.3 — transaction correction commands (pure domain).
 *
 * Six typed commands move canonical understanding without touching raw
 * source observations (those stay immutable; "View original" keeps showing
 * what the bank actually said):
 *
 *   transactions.setCategory
 *   transactions.setCounterparty
 *   transactions.addTags
 *   transactions.removeTags
 *   transactions.setNote
 *   transactions.excludeFromAnalytics
 *
 * Every command runs the standard lifecycle (idempotency, audit, outbox).
 * Concurrency is guarded twice: the executor compares the caller's
 * `expectedVersion` with the loaded row, and the write itself is a
 * compare-and-swap on the loaded version — a concurrent change between
 * load and write surfaces as VERSION_CONFLICT, never a silent overwrite.
 * Audit rows carry full before/after values so Issue 5.4 undo can
 * compensate without re-reading intent from anywhere else.
 */

export interface CorrectionTarget {
  id: string;
  version: number;
  categoryId: string | null;
  counterpartyId: string | null;
  note: string | null;
  excludedFromAnalytics: boolean;
}

export interface CorrectionPatch {
  categoryId?: string | null;
  counterpartyId?: string | null;
  note?: string | null;
  excludedFromAnalytics?: boolean;
}

export interface CorrectionData {
  findTransaction(workspaceId: string, transactionId: string): Promise<CorrectionTarget | null>;
  findCategory(
    workspaceId: string,
    categoryId: string,
  ): Promise<{ id: string; archivedAt: Date | null } | null>;
  findCounterparty(
    workspaceId: string,
    counterpartyId: string,
  ): Promise<{ id: string } | null>;
  findOrCreateCounterpartyByName(
    workspaceId: string,
    normalizedName: string,
    displayName: string,
  ): Promise<{ id: string }>;
  findOrCreateTag(workspaceId: string, name: string): Promise<{ id: string }>;
  listTransactionTagNames(workspaceId: string, transactionId: string): Promise<string[]>;
  addTagLinks(workspaceId: string, transactionId: string, tagIds: string[]): Promise<void>;
  removeTagLinks(workspaceId: string, transactionId: string, tagIds: string[]): Promise<void>;
  /**
   * Guarded write: applies `patch` and bumps version IFF the row still sits
   * at `loadedVersion`. Returns the new version, or null when another writer
   * moved the row first (caller turns that into VERSION_CONFLICT).
   */
  applyCorrection(
    workspaceId: string,
    transactionId: string,
    patch: CorrectionPatch,
    loadedVersion: number,
  ): Promise<{ version: number } | null>;
}

export interface CorrectionResult {
  transactionId: string;
  version: number;
}

function missingTransaction(): CommandError {
  // Tenant-safe: unknown and foreign ids are indistinguishable (Issue 1.2).
  return new CommandError("FORBIDDEN", "Transaction not found in this workspace.");
}

function checkTagName(raw: unknown): string {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new CommandError("INVARIANT_VIOLATION", "Tag names must be non-empty strings.");
  }
  const name = raw.trim();
  if (name.length > 40) {
    throw new CommandError("INVARIANT_VIOLATION", `Tag is too long (max 40): ${name}.`);
  }
  return name;
}

function normalizeCounterpartyName(raw: unknown): { normalized: string; display: string } {
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new CommandError("INVARIANT_VIOLATION", "Counterparty name must be a non-empty string.");
  }
  const display = raw.trim();
  if (display.length > 120) {
    throw new CommandError("INVARIANT_VIOLATION", "Counterparty name is too long (max 120).");
  }
  return { normalized: display.toLowerCase(), display };
}

async function guardedApply(
  data: CorrectionData,
  workspaceId: string,
  transactionId: string,
  loadedVersion: number,
  patch: CorrectionPatch,
): Promise<number> {
  const applied = await data.applyCorrection(workspaceId, transactionId, patch, loadedVersion);
  if (!applied) {
    throw new CommandError(
      "VERSION_CONFLICT",
      `stale version for transaction: expected ${loadedVersion}, row changed concurrently`,
      { expectedVersion: loadedVersion },
    );
  }
  return applied.version;
}

export interface SetCategoryInput {
  transactionId: string;
  /** Null (or omitted) clears the category back to uncategorized. */
  categoryId?: string | null;
}

export interface SetCategoryResult extends CorrectionResult {
  categoryId: string | null;
}

/** `transactions.setCategory`: point a transaction at an owned, live category. */
export function createSetCategoryCommand(
  data: CorrectionData,
): CommandDefinition<
  {
    workspaceId: string;
    transaction: CorrectionTarget | null;
    category: { id: string; archivedAt: Date | null } | null;
  },
  SetCategoryInput,
  SetCategoryResult
> {
  return {
    name: "transactions.setCategory",
    authorize: () => {},
    async loadState(ctx, input) {
      const transaction = await data.findTransaction(ctx.workspaceId, input.transactionId);
      const category =
        input.categoryId === null || input.categoryId === undefined
          ? null
          : await data.findCategory(ctx.workspaceId, input.categoryId);
      return { workspaceId: ctx.workspaceId, transaction, category };
    },
    currentVersionOf: (state) => state.transaction?.version ?? null,
    checkInvariant(state, input) {
      if (!state.transaction) {
        throw missingTransaction();
      }
      if (input.categoryId !== null && input.categoryId !== undefined && !state.category) {
        throw new CommandError("FORBIDDEN", "Category not found in this workspace.");
      }
      if (state.category?.archivedAt) {
        throw new CommandError("INVARIANT_VIOLATION", "Category is archived.");
      }
    },
    async mutate(state, input) {
      const transaction = state.transaction;
      if (!transaction) {
        throw missingTransaction();
      }
      const version = await guardedApply(
        data,
        state.workspaceId,
        transaction.id,
        transaction.version,
        { categoryId: input.categoryId ?? null },
      );
      const mutation: CommandMutation<SetCategoryResult> = {
        resultingVersion: version,
        result: { transactionId: transaction.id, version, categoryId: input.categoryId ?? null },
        audit: {
          entityType: "transaction",
          entityId: transaction.id,
          action: "transactions.setCategory",
          oldValue: { categoryId: transaction.categoryId, version: transaction.version },
          newValue: { categoryId: input.categoryId ?? null, version },
        },
        outbox: [
          {
            aggregateType: "transaction",
            aggregateId: transaction.id,
            eventType: "transaction.category_changed",
            payload: {
              transactionId: transaction.id,
              categoryId: input.categoryId ?? null,
              version,
            },
          },
        ],
      };
      return mutation;
    },
  };
}

export interface SetCounterpartyInput {
  transactionId: string;
  /** Owned counterparty id, or null to clear. Mutually exclusive with `counterpartyName`. */
  counterpartyId?: string | null;
  /** New merchant label; created when missing. Mutually exclusive with `counterpartyId`. */
  counterpartyName?: string | null;
}

export interface SetCounterpartyResult extends CorrectionResult {
  counterpartyId: string | null;
}

/** `transactions.setCounterparty`: re-point (or clear) the merchant, creating it by name when needed. */
export function createSetCounterpartyCommand(
  data: CorrectionData,
): CommandDefinition<
  {
    workspaceId: string;
    transaction: CorrectionTarget | null;
    counterparty: { id: string } | null;
  },
  SetCounterpartyInput,
  SetCounterpartyResult
> {
  return {
    name: "transactions.setCounterparty",
    authorize: () => {},
    async loadState(ctx, input) {
      const transaction = await data.findTransaction(ctx.workspaceId, input.transactionId);
      const named = input.counterpartyName !== null && input.counterpartyName !== undefined;
      const byId = input.counterpartyId !== null && input.counterpartyId !== undefined;
      const counterparty =
        transaction && byId && !named
          ? await data.findCounterparty(
              ctx.workspaceId,
              input.counterpartyId as string,
            )
          : null;
      return { workspaceId: ctx.workspaceId, transaction, counterparty };
    },
    currentVersionOf: (state) => state.transaction?.version ?? null,
    checkInvariant(state, input) {
      if (!state.transaction) {
        throw missingTransaction();
      }
      const hasId = input.counterpartyId !== null && input.counterpartyId !== undefined;
      const hasName = input.counterpartyName !== null && input.counterpartyName !== undefined;
      if (hasId && hasName) {
        throw new CommandError(
          "INVARIANT_VIOLATION",
          "Provide either counterpartyId or counterpartyName, not both.",
        );
      }
      if (hasId && !state.counterparty) {
        throw new CommandError("FORBIDDEN", "Counterparty not found in this workspace.");
      }
      if (hasName) {
        normalizeCounterpartyName(input.counterpartyName);
      }
    },
    async mutate(state, input) {
      const transaction = state.transaction;
      if (!transaction) {
        throw missingTransaction();
      }
      let counterpartyId: string | null = null;
      if (input.counterpartyName !== null && input.counterpartyName !== undefined) {
        const { normalized, display } = normalizeCounterpartyName(input.counterpartyName);
        const created = await data.findOrCreateCounterpartyByName(
          state.workspaceId,
          normalized,
          display,
        );
        counterpartyId = created.id;
      } else if (input.counterpartyId !== null && input.counterpartyId !== undefined) {
        const counterparty = state.counterparty;
        if (!counterparty) {
          throw new CommandError("FORBIDDEN", "Counterparty not found in this workspace.");
        }
        counterpartyId = counterparty.id;
      }
      const version = await guardedApply(
        data,
        state.workspaceId,
        transaction.id,
        transaction.version,
        { counterpartyId },
      );
      const mutation: CommandMutation<SetCounterpartyResult> = {
        resultingVersion: version,
        result: { transactionId: transaction.id, version, counterpartyId },
        audit: {
          entityType: "transaction",
          entityId: transaction.id,
          action: "transactions.setCounterparty",
          oldValue: { counterpartyId: transaction.counterpartyId, version: transaction.version },
          newValue: { counterpartyId, version },
        },
        outbox: [
          {
            aggregateType: "transaction",
            aggregateId: transaction.id,
            eventType: "transaction.counterparty_changed",
            payload: { transactionId: transaction.id, counterpartyId, version },
          },
        ],
      };
      return mutation;
    },
  };
}

export interface AddTagsInput {
  transactionId: string;
  tags: string[];
}

export interface TagsResult extends CorrectionResult {
  tags: string[];
}

/** `transactions.addTags`: attach tags (creating them), reporting the full resulting set. */
export function createAddTagsCommand(
  data: CorrectionData,
): CommandDefinition<
  { workspaceId: string; transaction: CorrectionTarget | null; before: string[] },
  AddTagsInput,
  TagsResult
> {
  return {
    name: "transactions.addTags",
    authorize: () => {},
    async loadState(ctx, input) {
      const transaction = await data.findTransaction(ctx.workspaceId, input.transactionId);
      const before = transaction
        ? await data.listTransactionTagNames(ctx.workspaceId, transaction.id)
        : [];
      return { workspaceId: ctx.workspaceId, transaction, before };
    },
    currentVersionOf: (state) => state.transaction?.version ?? null,
    checkInvariant(state, input) {
      if (!state.transaction) {
        throw missingTransaction();
      }
      if (!Array.isArray(input.tags) || input.tags.length === 0) {
        throw new CommandError("INVARIANT_VIOLATION", "Provide at least one tag.");
      }
      if (input.tags.length > 20) {
        throw new CommandError("INVARIANT_VIOLATION", "Too many tags (max 20 per call).");
      }
      for (const tag of input.tags) {
        checkTagName(tag);
      }
    },
    async mutate(state, input) {
      const transaction = state.transaction;
      if (!transaction) {
        throw missingTransaction();
      }
      const names = [...new Set(input.tags.map((t) => checkTagName(t)))];
      const ids: string[] = [];
      for (const name of names) {
        ids.push((await data.findOrCreateTag(state.workspaceId, name)).id);
      }
      await data.addTagLinks(state.workspaceId, transaction.id, ids);
      const after = await data.listTransactionTagNames(state.workspaceId, transaction.id);
      const version = await guardedApply(data, state.workspaceId, transaction.id, transaction.version, {});
      const mutation: CommandMutation<TagsResult> = {
        resultingVersion: version,
        result: { transactionId: transaction.id, version, tags: after },
        audit: {
          entityType: "transaction",
          entityId: transaction.id,
          action: "transactions.addTags",
          oldValue: { tags: state.before, version: transaction.version },
          newValue: { tags: after, version },
        },
        outbox: [
          {
            aggregateType: "transaction",
            aggregateId: transaction.id,
            eventType: "transaction.tags_changed",
            payload: { transactionId: transaction.id, tags: after, version },
          },
        ],
      };
      return mutation;
    },
  };
}

export interface RemoveTagsInput {
  transactionId: string;
  tags: string[];
}

/** `transactions.removeTags`: detach tags, reporting the full resulting set. */
export function createRemoveTagsCommand(
  data: CorrectionData,
): CommandDefinition<
  { workspaceId: string; transaction: CorrectionTarget | null; before: string[] },
  RemoveTagsInput,
  TagsResult
> {
  return {
    name: "transactions.removeTags",
    authorize: () => {},
    async loadState(ctx, input) {
      const transaction = await data.findTransaction(ctx.workspaceId, input.transactionId);
      const before = transaction
        ? await data.listTransactionTagNames(ctx.workspaceId, transaction.id)
        : [];
      return { workspaceId: ctx.workspaceId, transaction, before };
    },
    currentVersionOf: (state) => state.transaction?.version ?? null,
    checkInvariant(state, input) {
      if (!state.transaction) {
        throw missingTransaction();
      }
      if (!Array.isArray(input.tags) || input.tags.length === 0) {
        throw new CommandError("INVARIANT_VIOLATION", "Provide at least one tag.");
      }
      for (const tag of input.tags) {
        checkTagName(tag);
      }
    },
    async mutate(state, input) {
      const transaction = state.transaction;
      if (!transaction) {
        throw missingTransaction();
      }
      const names = [...new Set(input.tags.map((t) => checkTagName(t)))];
      const beforeSet = new Set(state.before);
      const ids: string[] = [];
      for (const name of names) {
        if (beforeSet.has(name)) {
          ids.push((await data.findOrCreateTag(state.workspaceId, name)).id);
        }
      }
      if (ids.length > 0) {
        await data.removeTagLinks(state.workspaceId, transaction.id, ids);
      }
      const after = await data.listTransactionTagNames(state.workspaceId, transaction.id);
      const version = await guardedApply(data, state.workspaceId, transaction.id, transaction.version, {});
      const mutation: CommandMutation<TagsResult> = {
        resultingVersion: version,
        result: { transactionId: transaction.id, version, tags: after },
        audit: {
          entityType: "transaction",
          entityId: transaction.id,
          action: "transactions.removeTags",
          oldValue: { tags: state.before, version: transaction.version },
          newValue: { tags: after, version },
        },
        outbox: [
          {
            aggregateType: "transaction",
            aggregateId: transaction.id,
            eventType: "transaction.tags_changed",
            payload: { transactionId: transaction.id, tags: after, version },
          },
        ],
      };
      return mutation;
    },
  };
}

export interface SetNoteInput {
  transactionId: string;
  /** Null (or omitted) clears the note. */
  note?: string | null;
}

export interface SetNoteResult extends CorrectionResult {
  note: string | null;
}

/** `transactions.setNote`: replace (or clear) the free-form user note. */
export function createSetNoteCommand(
  data: CorrectionData,
): CommandDefinition<
  { workspaceId: string; transaction: CorrectionTarget | null },
  SetNoteInput,
  SetNoteResult
> {
  return {
    name: "transactions.setNote",
    authorize: () => {},
    async loadState(ctx, input) {
      return {
        workspaceId: ctx.workspaceId,
        transaction: await data.findTransaction(ctx.workspaceId, input.transactionId),
      };
    },
    currentVersionOf: (state) => state.transaction?.version ?? null,
    checkInvariant(state, input) {
      if (!state.transaction) {
        throw missingTransaction();
      }
      if (input.note !== null && input.note !== undefined) {
        if (typeof input.note !== "string") {
          throw new CommandError("INVARIANT_VIOLATION", "Note must be a string or null.");
        }
        if (input.note.length > 2000) {
          throw new CommandError("INVARIANT_VIOLATION", "Note is too long (max 2000).");
        }
      }
    },
    async mutate(state, input) {
      const transaction = state.transaction;
      if (!transaction) {
        throw missingTransaction();
      }
      const note = input.note ?? null;
      const version = await guardedApply(data, state.workspaceId, transaction.id, transaction.version, {
        note,
      });
      const mutation: CommandMutation<SetNoteResult> = {
        resultingVersion: version,
        result: { transactionId: transaction.id, version, note },
        audit: {
          entityType: "transaction",
          entityId: transaction.id,
          action: "transactions.setNote",
          oldValue: { note: transaction.note, version: transaction.version },
          newValue: { note, version },
        },
        outbox: [
          {
            aggregateType: "transaction",
            aggregateId: transaction.id,
            eventType: "transaction.note_changed",
            payload: { transactionId: transaction.id, version },
          },
        ],
      };
      return mutation;
    },
  };
}

export interface ExcludeFromAnalyticsInput {
  transactionId: string;
  excluded: boolean;
}

export interface ExcludeFromAnalyticsResult extends CorrectionResult {
  excluded: boolean;
}

/** `transactions.excludeFromAnalytics`: hide (or restore) a row in analytics without deleting it. */
export function createExcludeFromAnalyticsCommand(
  data: CorrectionData,
): CommandDefinition<
  { workspaceId: string; transaction: CorrectionTarget | null },
  ExcludeFromAnalyticsInput,
  ExcludeFromAnalyticsResult
> {
  return {
    name: "transactions.excludeFromAnalytics",
    authorize: () => {},
    async loadState(ctx, input) {
      return {
        workspaceId: ctx.workspaceId,
        transaction: await data.findTransaction(ctx.workspaceId, input.transactionId),
      };
    },
    currentVersionOf: (state) => state.transaction?.version ?? null,
    checkInvariant(state, input) {
      if (!state.transaction) {
        throw missingTransaction();
      }
      if (typeof input.excluded !== "boolean") {
        throw new CommandError("INVARIANT_VIOLATION", "excluded must be a boolean.");
      }
    },
    async mutate(state, input) {
      const transaction = state.transaction;
      if (!transaction) {
        throw missingTransaction();
      }
      const version = await guardedApply(
        data,
        state.workspaceId,
        transaction.id,
        transaction.version,
        { excludedFromAnalytics: input.excluded },
      );
      const mutation: CommandMutation<ExcludeFromAnalyticsResult> = {
        resultingVersion: version,
        result: { transactionId: transaction.id, version, excluded: input.excluded },
        audit: {
          entityType: "transaction",
          entityId: transaction.id,
          action: "transactions.excludeFromAnalytics",
          oldValue: {
            excludedFromAnalytics: transaction.excludedFromAnalytics,
            version: transaction.version,
          },
          newValue: { excludedFromAnalytics: input.excluded, version },
        },
        outbox: [
          {
            aggregateType: "transaction",
            aggregateId: transaction.id,
            eventType: "transaction.exclusion_changed",
            payload: { transactionId: transaction.id, excluded: input.excluded, version },
          },
        ],
      };
      return mutation;
    },
  };
}
