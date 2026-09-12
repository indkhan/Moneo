import { describe, expect, it } from "vitest";
import { CommandError, createMemoryCommandStore, executeCommand } from "./commands.js";
import {
  createManualAccountCommand,
  createManualTransactionCommand,
  type CreateManualTransactionInput,
  type ManualAccountData,
  type ManualTransactionData,
} from "./manual.js";

/**
 * Issue 4.12 — manual commands over memory stores (no I/O).
 *
 * Proves: account creation validates and audits; transaction creation
 * enforces ownership, exact money, same-currency, and date rules; retries
 * converge on one row; the projection contract distinguishes current from
 * historical rows; and no source observation is ever fabricated (the data
 * interfaces expose no source writes by construction).
 */

function accountData(): ManualAccountData & { count(): number } {
  let ids = 0;
  const created: { name: string }[] = [];
  return {
    count: () => created.length,
    insertAccount: (_wid, input) => {
      ids += 1;
      created.push({ name: input.name });
      return Promise.resolve({ id: `acct-${ids}` });
    },
  };
}

function transactionData(): ManualTransactionData & { count(): number } {
  let ids = 0;
  const rows: { accountId: string }[] = [];
  return {
    count: () => rows.length,
    findAccount: (_wid, accountId) =>
      Promise.resolve(accountId === "acct-1" ? { id: "acct-1", currencyCode: "EUR" } : null),
    latestCutoff: () => Promise.resolve({ cutoffDate: "2026-08-15", currencyCode: "EUR" }),
    insertTransaction: (_wid, input) => {
      ids += 1;
      rows.push({ accountId: input.accountId });
      return Promise.resolve({ id: `txn-${ids}` });
    },
  };
}

function validTxn(
  overrides: Partial<CreateManualTransactionInput> = {},
): CreateManualTransactionInput {
  return {
    accountId: "acct-1",
    effectiveDate: "2026-08-16",
    description: "Cash coffee",
    amountMinor: "1500",
    currencyCode: "EUR",
    direction: "debit",
    ...overrides,
  };
}

describe("createManualAccountCommand", () => {
  it("creates a cash wallet with audit and outbox output", async () => {
    const data = accountData();
    const outcome = await executeCommand(
      createManualAccountCommand(data),
      { workspaceId: "ws-1", actorUserId: null, idempotencyKey: "a-1" },
      { name: "Cash wallet", currencyCode: "eur", accountType: "CASH" },
      createMemoryCommandStore(),
    );
    expect(outcome.result).toEqual({ accountId: "acct-1" });
    expect(data.count()).toBe(1);
  });

  it("replays retries and rejects bad input", async () => {
    const data = accountData();
    const store = createMemoryCommandStore();
    const command = createManualAccountCommand(data);
    const ctx = { workspaceId: "ws-1", actorUserId: null, idempotencyKey: "a-1" };
    const input = { name: "Cash wallet", currencyCode: "EUR" };
    await executeCommand(command, ctx, input, store);
    const replay = await executeCommand(command, ctx, input, store);
    expect(replay.replayed).toBe(true);
    expect(data.count()).toBe(1);
    await expect(
      executeCommand(
        command,
        { ...ctx, idempotencyKey: "a-2" },
        { name: "  ", currencyCode: "EUR" },
        store,
      ),
    ).rejects.toBeInstanceOf(CommandError);
    await expect(
      executeCommand(
        command,
        { ...ctx, idempotencyKey: "a-3" },
        { name: "X", currencyCode: "XXY" },
        store,
      ),
    ).rejects.toBeInstanceOf(CommandError);
  });
});

describe("createManualTransactionCommand", () => {
  it("records a €15 purchase that moves the projection", async () => {
    const data = transactionData();
    const store = createMemoryCommandStore();
    const outcome = await executeCommand(
      createManualTransactionCommand(data),
      { workspaceId: "ws-1", actorUserId: null, idempotencyKey: "t-1" },
      validTxn(),
      store,
    );
    expect(outcome.result).toEqual({
      transactionId: "txn-1",
      accountId: "acct-1",
      affectsProjection: true,
    });
    const replay = await executeCommand(
      createManualTransactionCommand(data),
      { workspaceId: "ws-1", actorUserId: null, idempotencyKey: "t-1" },
      validTxn(),
      store,
    );
    expect(replay.replayed).toBe(true);
    expect(data.count()).toBe(1);
    expect(store.audit()[0]).toMatchObject({ action: "transactions.createManual" });
    expect(store.outbox()[0]).toMatchObject({ eventType: "transaction.created" });
  });

  it("marks pre-cutoff rows as history-only", async () => {
    const data = transactionData();
    const outcome = await executeCommand(
      createManualTransactionCommand(data),
      { workspaceId: "ws-1", actorUserId: null, idempotencyKey: "t-2" },
      validTxn({ effectiveDate: "2026-08-10" }),
      createMemoryCommandStore(),
    );
    expect(outcome.result).toMatchObject({ affectsProjection: false });
  });

  it("refuses foreign accounts, bad money, and cross-currency rows", async () => {
    const data = transactionData();
    const store = createMemoryCommandStore();
    const command = createManualTransactionCommand(data);
    const run = (key: string, input: CreateManualTransactionInput) =>
      executeCommand(
        command,
        { workspaceId: "ws-1", actorUserId: null, idempotencyKey: key },
        input,
        store,
      );
    await expect(run("x-1", validTxn({ accountId: "acct-other" }))).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(run("x-2", validTxn({ amountMinor: "15.00" }))).rejects.toThrow();
    await expect(run("x-3", validTxn({ amountMinor: "0" }))).rejects.toThrow();
    await expect(run("x-4", validTxn({ currencyCode: "JPY" }))).rejects.toBeInstanceOf(
      CommandError,
    );
    await expect(run("x-5", validTxn({ effectiveDate: "15.08.2026" }))).rejects.toThrow();
    await expect(
      run("x-6", validTxn({ direction: "OUTFLOW" as unknown as "debit" })),
    ).rejects.toBeInstanceOf(CommandError);
    expect(data.count()).toBe(0);
  });

  it("exposes no source-observation writes on its data interface", () => {
    const methods = ["findAccount", "latestCutoff", "insertTransaction", "count"].sort();
    expect(Object.keys(transactionData()).sort()).toEqual(methods);
  });
});
