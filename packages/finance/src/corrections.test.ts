import { describe, expect, it } from "vitest";
import {
  createMemoryCommandStore,
  executeCommand,
  type CommandContext,
  type CommandError,
} from "./commands.js";
import {
  createAddTagsCommand,
  createExcludeFromAnalyticsCommand,
  createRemoveTagsCommand,
  createSetCategoryCommand,
  createSetCounterpartyCommand,
  createSetNoteCommand,
  type CorrectionData,
  type CorrectionTarget,
} from "./corrections.js";

/**
 * Issue 5.3 — correction commands against an in-memory backend.
 *
 * Proves the pure domain rules without PostgreSQL: happy paths bump the
 * version and emit audit/outbox records, unknown or foreign ids fail
 * closed (FORBIDDEN), archived categories and oversized notes are rejected,
 * idempotent replays return the stored result, and a stale expected version
 * fails with VERSION_CONFLICT.
 */

interface MemoryDb {
  transactions: Map<string, CorrectionTarget>;
  categories: Map<string, { id: string; archivedAt: Date | null }>;
  counterparties: Map<string, { id: string }>;
  tags: Map<string, { id: string; name: string }>;
  links: Map<string, Set<string>>;
}

function seedDb(): MemoryDb {
  return {
    transactions: new Map([
      [
        "txn-1",
        {
          id: "txn-1",
          version: 1,
          categoryId: null,
          counterpartyId: null,
          note: null,
          excludedFromAnalytics: false,
        },
      ],
    ]),
    categories: new Map([["cat-1", { id: "cat-1", archivedAt: null }]]),
    counterparties: new Map([["cp-1", { id: "cp-1" }]]),
    tags: new Map(),
    links: new Map([["txn-1", new Set()]]),
  };
}

function tagNames(db: MemoryDb, txnId: string): string[] {
  const ids = db.links.get(txnId) ?? new Set<string>();
  const names: string[] = [];
  for (const tag of db.tags.values()) {
    if (ids.has(tag.id)) {
      names.push(tag.name);
    }
  }
  return names.sort();
}

function createData(db: MemoryDb): CorrectionData {
  return {
    findTransaction: (_ws, id) => Promise.resolve(db.transactions.get(id) ?? null),
    findCategory: (_ws, id) => Promise.resolve(db.categories.get(id) ?? null),
    findCounterparty: (_ws, id) => Promise.resolve(db.counterparties.get(id) ?? null),
    findOrCreateCounterpartyByName: (_ws, normalized, _display) => {
      const id = `cp-${normalized}`;
      if (!db.counterparties.has(id)) {
        db.counterparties.set(id, { id });
      }
      return Promise.resolve({ id });
    },
    findOrCreateTag: (_ws, name) => {
      const id = `tag-${name}`;
      if (!db.tags.has(id)) {
        db.tags.set(id, { id, name });
      }
      return Promise.resolve({ id });
    },
    listTransactionTagNames: (_ws, txnId) => Promise.resolve(tagNames(db, txnId)),
    addTagLinks: (_ws, txnId, tagIds) => {
      const set = db.links.get(txnId) ?? new Set<string>();
      for (const id of tagIds) {
        set.add(id);
      }
      db.links.set(txnId, set);
      return Promise.resolve();
    },
    removeTagLinks: (_ws, txnId, tagIds) => {
      const set = db.links.get(txnId) ?? new Set<string>();
      for (const id of tagIds) {
        set.delete(id);
      }
      return Promise.resolve();
    },
    applyCorrection: (_ws, txnId, patch, loadedVersion) => {
      const txn = db.transactions.get(txnId);
      if (!txn || txn.version !== loadedVersion) {
        return Promise.resolve(null);
      }
      const next: CorrectionTarget = {
        ...txn,
        version: txn.version + 1,
        ...(patch.categoryId !== undefined ? { categoryId: patch.categoryId } : {}),
        ...(patch.counterpartyId !== undefined ? { counterpartyId: patch.counterpartyId } : {}),
        ...(patch.note !== undefined ? { note: patch.note } : {}),
        ...(patch.excludedFromAnalytics !== undefined
          ? { excludedFromAnalytics: patch.excludedFromAnalytics }
          : {}),
      };
      db.transactions.set(txnId, next);
      return Promise.resolve({ version: next.version });
    },
  };
}

function ctx(key: string, expectedVersion?: number): CommandContext {
  return {
    workspaceId: "ws-1",
    actorUserId: "user-1",
    idempotencyKey: key,
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
  };
}

describe("transaction correction commands", () => {
  it("sets the category and records audit + outbox", async () => {
    const db = seedDb();
    const store = createMemoryCommandStore();
    const outcome = await executeCommand(
      createSetCategoryCommand(createData(db)),
      ctx("k-1", 1),
      { transactionId: "txn-1", categoryId: "cat-1" },
      store,
    );
    expect(outcome.result).toMatchObject({ transactionId: "txn-1", version: 2, categoryId: "cat-1" });
    expect(outcome.replayed).toBe(false);
    expect(db.transactions.get("txn-1")).toMatchObject({ categoryId: "cat-1", version: 2 });
    const audits = store.audit();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      entityType: "transaction",
      entityId: "txn-1",
      action: "transactions.setCategory",
    });
    expect(store.outbox()).toMatchObject([{ eventType: "transaction.category_changed" }]);
  });

  it("replays the same idempotency key without re-mutating", async () => {
    const db = seedDb();
    const store = createMemoryCommandStore();
    const def = createSetNoteCommand(createData(db));
    const first = await executeCommand(def, ctx("k-note"), { transactionId: "txn-1", note: "hi" }, store);
    const second = await executeCommand(
      def,
      ctx("k-note"),
      { transactionId: "txn-1", note: "hi" },
      store,
    );
    expect(second.replayed).toBe(true);
    expect(second.result).toEqual(first.result);
    expect(db.transactions.get("txn-1")?.version).toBe(2);
  });

  it("fails closed on unknown transactions, categories, and counterparties", async () => {
    const store = createMemoryCommandStore();
    const data = createData(seedDb());
    await expect(
      executeCommand(
        createSetCategoryCommand(data),
        ctx("k-x1"),
        { transactionId: "nope", categoryId: "cat-1" },
        store,
      ).then(
        () => "resolved",
        (error: unknown) => (error as CommandError).code,
      ),
    ).resolves.toBe("FORBIDDEN");
    await expect(
      executeCommand(
        createSetCategoryCommand(data),
        ctx("k-x2"),
        { transactionId: "txn-1", categoryId: "nope" },
        store,
      ).then(
        () => "resolved",
        (error: unknown) => (error as CommandError).code,
      ),
    ).resolves.toBe("FORBIDDEN");
    await expect(
      executeCommand(
        createSetCounterpartyCommand(data),
        ctx("k-x3"),
        { transactionId: "txn-1", counterpartyId: "nope" },
        store,
      ).then(
        () => "resolved",
        (error: unknown) => (error as CommandError).code,
      ),
    ).resolves.toBe("FORBIDDEN");
  });

  it("rejects archived categories, dual counterparty inputs, and bad notes", async () => {
    const db = seedDb();
    db.categories.set("cat-old", { id: "cat-old", archivedAt: new Date() });
    const store = createMemoryCommandStore();
    const data = createData(db);
    const archived = await executeCommand(
      createSetCategoryCommand(data),
      ctx("k-a1"),
      { transactionId: "txn-1", categoryId: "cat-old" },
      store,
    ).then(
      () => "resolved",
      (error: unknown) => (error as CommandError).code,
    );
    expect(archived).toBe("INVARIANT_VIOLATION");
    const dual = await executeCommand(
      createSetCounterpartyCommand(data),
      ctx("k-a2"),
      { transactionId: "txn-1", counterpartyId: "cp-1", counterpartyName: "Lidl" },
      store,
    ).then(
      () => "resolved",
      (error: unknown) => (error as CommandError).code,
    );
    expect(dual).toBe("INVARIANT_VIOLATION");
    const long = await executeCommand(
      createSetNoteCommand(data),
      ctx("k-a3"),
      { transactionId: "txn-1", note: "x".repeat(2001) },
      store,
    ).then(
      () => "resolved",
      (error: unknown) => (error as CommandError).code,
    );
    expect(long).toBe("INVARIANT_VIOLATION");
  });

  it("creates counterparties by name and clears them by null", async () => {
    const db = seedDb();
    const store = createMemoryCommandStore();
    const data = createData(db);
    const named = await executeCommand(
      createSetCounterpartyCommand(data),
      ctx("k-c1", 1),
      { transactionId: "txn-1", counterpartyName: "Lidl" },
      store,
    );
    expect(named.result.counterpartyId).toBe("cp-lidl");
    const cleared = await executeCommand(
      createSetCounterpartyCommand(data),
      ctx("k-c2", 2),
      { transactionId: "txn-1", counterpartyId: null },
      store,
    );
    expect(cleared.result).toMatchObject({ version: 3, counterpartyId: null });
  });

  it("adds and removes tags with full before/after audit", async () => {
    const db = seedDb();
    const store = createMemoryCommandStore();
    const data = createData(db);
    const added = await executeCommand(
      createAddTagsCommand(data),
      ctx("k-t1", 1),
      { transactionId: "txn-1", tags: ["food", " germany ", "food"] },
      store,
    );
    expect(added.result).toMatchObject({ version: 2, tags: ["food", "germany"] });
    const removed = await executeCommand(
      createRemoveTagsCommand(data),
      ctx("k-t2", 2),
      { transactionId: "txn-1", tags: ["food", "absent"] },
      store,
    );
    expect(removed.result).toMatchObject({ version: 3, tags: ["germany"] });
    const audits = store.audit();
    expect(audits[1]).toMatchObject({
      action: "transactions.removeTags",
      oldValue: { tags: ["food", "germany"] },
      newValue: { tags: ["germany"] },
    });
  });

  it("toggles analytics exclusion with a boolean guard", async () => {
    const db = seedDb();
    const store = createMemoryCommandStore();
    const outcome = await executeCommand(
      createExcludeFromAnalyticsCommand(createData(db)),
      ctx("k-e1", 1),
      { transactionId: "txn-1", excluded: true },
      store,
    );
    expect(outcome.result).toMatchObject({ version: 2, excluded: true });
    expect(db.transactions.get("txn-1")?.excludedFromAnalytics).toBe(true);
  });

  it("rejects stale expected versions without touching the row", async () => {
    const db = seedDb();
    const store = createMemoryCommandStore();
    const data = createData(db);
    await executeCommand(
      createSetNoteCommand(data),
      ctx("k-s1", 1),
      { transactionId: "txn-1", note: "first" },
      store,
    );
    const code = await executeCommand(
      createSetNoteCommand(data),
      ctx("k-s2", 1),
      { transactionId: "txn-1", note: "stale" },
      store,
    ).then(
      () => "resolved",
      (error: unknown) => (error as CommandError).code,
    );
    expect(code).toBe("VERSION_CONFLICT");
    expect(db.transactions.get("txn-1")).toMatchObject({ note: "first", version: 2 });
  });
});
