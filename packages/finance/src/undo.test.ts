import { describe, expect, it } from "vitest";
import {
  createMemoryCommandStore,
  executeCommand,
  type CommandContext,
  type CommandError,
} from "./commands.js";
import {
  createSetCategoryCommand,
  createSetNoteCommand,
  createAddTagsCommand,
  type CorrectionTarget,
} from "./corrections.js";
import {
  compensationFor,
  createUndoCommand,
  parseOperationId,
  type UndoData,
  type UndoOperation,
} from "./undo.js";

/**
 * Issue 5.4 — compensating undo against an in-memory backend.
 *
 * Proves the pure domain rules: undo restores the recorded old value and
 * bumps the version, tag undos restore the exact recorded set, unknown or
 * foreign operations fail closed, non-undoable actions are rejected, and a
 * newer change after the undone operation fails with UNDO_CONFLICT instead
 * of overwriting it.
 */

interface MemoryDb {
  transactions: Map<string, CorrectionTarget>;
  categories: Set<string>;
  tags: Map<string, { id: string; name: string }>;
  links: Map<string, Set<string>>;
  operations: Map<string, UndoOperation>;
}

function seedDb(): MemoryDb {
  return {
    transactions: new Map([
      [
        "txn-1",
        {
          id: "txn-1",
          version: 2,
          categoryId: "cat-new",
          counterpartyId: null,
          note: null,
          excludedFromAnalytics: false,
        },
      ],
    ]),
    categories: new Set(["cat-new", "cat-9"]),
    tags: new Map(),
    links: new Map(),
    operations: new Map([
      [
        "ws-1:transactions.setCategory:k-1",
        {
          commandName: "transactions.setCategory",
          resultingVersion: 2,
          entityType: "transaction",
          entityId: "txn-1",
          action: "transactions.setCategory",
          oldValue: { categoryId: null, version: 1 },
          newValue: { categoryId: "cat-new", version: 2 },
        },
      ],
    ]),
  };
}

function tagNames(db: MemoryDb, txnId: string): string[] {
  const ids = db.links.get(txnId) ?? new Set<string>();
  return [...db.tags.values()]
    .filter((t) => ids.has(t.id))
    .map((t) => t.name)
    .sort();
}

function createData(db: MemoryDb): UndoData {
  return {
    findTransaction: (_ws, id) => Promise.resolve(db.transactions.get(id) ?? null),
    findCategory: (_ws, id) =>
      Promise.resolve(db.categories.has(id) ? { id, archivedAt: null } : null),
    findCounterparty: () => Promise.resolve(null),
    findOrCreateCounterpartyByName: (_ws, normalized) =>
      Promise.resolve({ id: `cp-${normalized}` }),
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
    replaceTagLinks: (_ws, txnId, tagIds) => {
      db.links.set(txnId, new Set(tagIds));
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
    findOperation: (ws, commandName, key) =>
      Promise.resolve(db.operations.get(`${ws}:${commandName}:${key}`) ?? null),
  };
}

function ctx(key: string): CommandContext {
  return { workspaceId: "ws-1", actorUserId: "user-1", idempotencyKey: key };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "resolved";
  } catch (error) {
    return (error as CommandError).code;
  }
}

describe("compensating undo", () => {
  it("parses operation ids and rejects malformed ones", () => {
    expect(parseOperationId("ws-1:transactions.setCategory:k-1")).toEqual({
      workspaceId: "ws-1",
      commandName: "transactions.setCategory",
      idempotencyKey: "k-1",
    });
    // Keys may contain colons; only the first two separators are structural.
    expect(parseOperationId("ws-1:transactions.setNote:a:b:c").idempotencyKey).toBe("a:b:c");
    expect(() => parseOperationId("no-colons")).toThrowError();
    expect(() => parseOperationId(null)).toThrowError();
  });

  it("builds compensations from recorded old values", () => {
    expect(compensationFor("transactions.setCategory", { categoryId: "c1" })).toEqual({
      patch: { categoryId: "c1" },
      restoreTags: null,
    });
    expect(compensationFor("transactions.setCategory", null)).toEqual({
      patch: { categoryId: null },
      restoreTags: null,
    });
    expect(
      compensationFor("transactions.excludeFromAnalytics", { excludedFromAnalytics: true }),
    ).toEqual({ patch: { excludedFromAnalytics: true }, restoreTags: null });
    expect(compensationFor("transactions.addTags", { tags: ["a", "b"] })).toEqual({
      patch: {},
      restoreTags: ["a", "b"],
    });
    expect(() => compensationFor("accounts.recordBalance", {})).toThrowError();
  });

  it("restores the old category and records the compensating audit", async () => {
    const db = seedDb();
    const store = createMemoryCommandStore();
    const outcome = await executeCommand(
      createUndoCommand(createData(db)),
      ctx("u-1"),
      { operationId: "ws-1:transactions.setCategory:k-1" },
      store,
    );
    expect(outcome.result).toMatchObject({
      undoneOperationId: "ws-1:transactions.setCategory:k-1",
      transactionId: "txn-1",
      version: 3,
    });
    expect(db.transactions.get("txn-1")).toMatchObject({ categoryId: null, version: 3 });
    expect(store.audit()).toMatchObject([{ action: "operations.undo" }]);
    expect(store.outbox()).toMatchObject([{ eventType: "transaction.correction_undone" }]);
  });

  it("fails closed on unknown, foreign, and non-undoable operations", async () => {
    const db = seedDb();
    db.operations.set("ws-1:accounts.recordBalance:k-9", {
      commandName: "accounts.recordBalance",
      resultingVersion: 0,
      entityType: "account",
      entityId: "acct-1",
      action: "accounts.recordBalance",
      oldValue: null,
      newValue: {},
    });
    db.operations.set("ws-1:operations.undo:k-8", {
      commandName: "operations.undo",
      resultingVersion: 3,
      entityType: "transaction",
      entityId: "txn-1",
      action: "operations.undo",
      oldValue: {},
      newValue: {},
    });
    const store = createMemoryCommandStore();
    const data = createData(db);
    const def = createUndoCommand(data);
    expect(
      await codeOf(executeCommand(def, ctx("u-x1"), { operationId: "ws-1:zzz:nope" }, store)),
    ).toBe("FORBIDDEN");
    expect(
      await codeOf(
        executeCommand(
          def,
          ctx("u-x2"),
          { operationId: "ws-2:transactions.setCategory:k-1" },
          store,
        ),
      ),
    ).toBe("FORBIDDEN");
    expect(
      await codeOf(
        executeCommand(def, ctx("u-x3"), { operationId: "ws-1:accounts.recordBalance:k-9" }, store),
      ),
    ).toBe("INVARIANT_VIOLATION");
    expect(
      await codeOf(
        executeCommand(def, ctx("u-x4"), { operationId: "ws-1:operations.undo:k-8" }, store),
      ),
    ).toBe("FORBIDDEN");
  });

  it("refuses undo after a newer change with UNDO_CONFLICT", async () => {
    const db = seedDb();
    const store = createMemoryCommandStore();
    const data = createData(db);
    // A newer correction moves the row past the undone version.
    await executeCommand(
      createSetNoteCommand(data),
      { ...ctx("n-1"), expectedVersion: 2 },
      { transactionId: "txn-1", note: "newer" },
      store,
    );
    const code = await codeOf(
      executeCommand(
        createUndoCommand(data),
        ctx("u-new"),
        { operationId: "ws-1:transactions.setCategory:k-1" },
        store,
      ),
    );
    expect(code).toBe("UNDO_CONFLICT");
    // The newer note survives; the category stays as the newer change left it.
    expect(db.transactions.get("txn-1")).toMatchObject({
      note: "newer",
      categoryId: "cat-new",
      version: 3,
    });
  });

  it("restores the exact recorded tag set", async () => {
    const db = seedDb();
    db.transactions.set("txn-1", {
      id: "txn-1",
      version: 4,
      categoryId: "cat-new",
      counterpartyId: null,
      note: null,
      excludedFromAnalytics: false,
    });
    for (const name of ["food", "germany", "extra"]) {
      db.tags.set(`tag-${name}`, { id: `tag-${name}`, name });
    }
    db.links.set("txn-1", new Set(["tag-food", "tag-extra"]));
    db.operations.set("ws-1:transactions.addTags:k-t", {
      commandName: "transactions.addTags",
      resultingVersion: 4,
      entityType: "transaction",
      entityId: "txn-1",
      action: "transactions.addTags",
      oldValue: { tags: ["food", "germany"], version: 3 },
      newValue: { tags: ["food", "extra"], version: 4 },
    });
    // Align current links with the recorded "after" state.
    db.links.set("txn-1", new Set(["tag-food", "tag-extra"]));
    const store = createMemoryCommandStore();
    const outcome = await executeCommand(
      createUndoCommand(createData(db)),
      ctx("u-t"),
      { operationId: "ws-1:transactions.addTags:k-t" },
      store,
    );
    expect(outcome.result.version).toBe(5);
    expect(tagNames(db, "txn-1")).toEqual(["food", "germany"]);
  });

  it("round-trips a correction and its undo through the executor", async () => {
    const db = seedDb();
    db.transactions.set("txn-1", {
      id: "txn-1",
      version: 1,
      categoryId: null,
      counterpartyId: null,
      note: null,
      excludedFromAnalytics: false,
    });
    const store = createMemoryCommandStore();
    const data = createData(db);
    const done = await executeCommand(
      createSetCategoryCommand(data),
      { ...ctx("orig"), expectedVersion: 1 },
      { transactionId: "txn-1", categoryId: "cat-9" },
      store,
    );
    expect(done.result.version).toBe(2);
    db.operations.set("ws-1:transactions.setCategory:orig", {
      commandName: "transactions.setCategory",
      resultingVersion: 2,
      entityType: "transaction",
      entityId: "txn-1",
      action: "transactions.setCategory",
      oldValue: { categoryId: null, version: 1 },
      newValue: { categoryId: "cat-9", version: 2 },
    });
    const undone = await executeCommand(
      createUndoCommand(data),
      ctx("undo"),
      { operationId: "ws-1:transactions.setCategory:orig" },
      store,
    );
    expect(undone.result).toMatchObject({ version: 3 });
    expect(db.transactions.get("txn-1")).toMatchObject({ categoryId: null, version: 3 });
    // Undoing the undo is rejected: the compensating action is not undoable.
    db.operations.set("ws-1:operations.undo:undo", {
      commandName: "operations.undo",
      resultingVersion: 3,
      entityType: "transaction",
      entityId: "txn-1",
      action: "operations.undo",
      oldValue: {},
      newValue: {},
    });
    expect(
      await codeOf(
        executeCommand(
          createUndoCommand(data),
          ctx("undo2"),
          { operationId: "ws-1:operations.undo:undo" },
          store,
        ),
      ),
    ).toBe("FORBIDDEN");
  });

  it("leaves addTags usable alongside undo data", async () => {
    const db = seedDb();
    const store = createMemoryCommandStore();
    const outcome = await executeCommand(
      createAddTagsCommand(createData(db)),
      ctx("t-1"),
      { transactionId: "txn-1", tags: ["x"] },
      store,
    );
    expect(outcome.result.version).toBe(3);
  });
});
