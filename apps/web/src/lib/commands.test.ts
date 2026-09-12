import { CommandError } from "@moneo/finance";
import { describe, expect, it } from "vitest";
import {
  addTagsInputSchema,
  createDrizzleCommandRegistry,
  createManualAccountInputSchema,
  createManualTransactionInputSchema,
  excludeFromAnalyticsInputSchema,
  handleExecuteCommand,
  recordBalanceInputSchema,
  setCategoryInputSchema,
  setCounterpartyInputSchema,
  setNoteInputSchema,
  type CommandRegistration,
} from "./commands";

/**
 * Issue 4.10 — command dispatcher unit-tests without Postgres.
 *
 * Proves the HTTP boundary: 401 without a workspace, 404 for unknown
 * commands, envelope AND input validation before any run executes (with
 * field errors), verbatim outcome passthrough, and CommandError codes
 * mapped onto the documented problems.
 */

const WID = "11111111-1111-7111-8111-111111111111";

function body(overrides: Record<string, unknown> = {}) {
  return {
    metadata: { idempotencyKey: "k-1" },
    input: {
      accountId: "22222222-2222-7222-8222-222222222222",
      observedAt: "2026-08-15T12:00:00Z",
      currentAmountMinor: "10000",
      currencyCode: "EUR",
      source: "manual",
      cutoffDate: "2026-08-15",
    },
    ...overrides,
  };
}

function registration(
  run: CommandRegistration["run"] = () =>
    Promise.resolve({ operationId: "op-1", replayed: false, undoAvailable: false, result: {} }),
): CommandRegistration {
  return { inputSchema: recordBalanceInputSchema, run };
}

describe("handleExecuteCommand", () => {
  it("answers 401 without a workspace and never touches the registry", async () => {
    let calls = 0;
    const res = await handleExecuteCommand("accounts.recordBalance", body(), {
      workspaceId: undefined,
      actorUserId: null,
      registry: new Map([
        [
          "accounts.recordBalance",
          registration(() => ((calls += 1), Promise.resolve({} as never))),
        ],
      ]),
    });
    expect(res.status).toBe(401);
    expect(calls).toBe(0);
  });

  it("answers 404 for unknown commands", async () => {
    const res = await handleExecuteCommand("widgets.rename", body(), {
      workspaceId: WID,
      actorUserId: null,
      registry: new Map(),
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe("NOT_FOUND");
  });

  it("validates the envelope before any run executes", async () => {
    let calls = 0;
    const res = await handleExecuteCommand(
      "accounts.recordBalance",
      { metadata: { idempotencyKey: "" }, input: "nope" },
      {
        workspaceId: WID,
        actorUserId: null,
        registry: new Map([
          [
            "accounts.recordBalance",
            registration(() => ((calls += 1), Promise.resolve({} as never))),
          ],
        ]),
      },
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe("VALIDATION_FAILED");
    expect(calls).toBe(0);
  });

  it("validates command input with field errors before any run executes", async () => {
    let calls = 0;
    const res = await handleExecuteCommand(
      "accounts.recordBalance",
      body({ input: { accountId: "nope", source: "telepathy" } }),
      {
        workspaceId: WID,
        actorUserId: null,
        registry: new Map([
          [
            "accounts.recordBalance",
            registration(() => ((calls += 1), Promise.resolve({} as never))),
          ],
        ]),
      },
    );
    expect(res.status).toBe(400);
    const problem = (await res.json()) as { code: string; errors: { field: string }[] };
    expect(problem.code).toBe("VALIDATION_FAILED");
    expect(problem.errors.map((e) => e.field).join(",")).toContain("accountId");
    expect(calls).toBe(0);
  });

  it("passes validated input and outcomes through verbatim", async () => {
    const seen: unknown[] = [];
    const ok = await handleExecuteCommand("accounts.recordBalance", body(), {
      workspaceId: WID,
      actorUserId: "u-1",
      registry: new Map([
        [
          "accounts.recordBalance",
          registration((args) => {
            seen.push(args);
            return Promise.resolve({
              operationId: "op-1",
              replayed: true,
              undoAvailable: false,
              result: { ok: true },
            });
          }),
        ],
      ]),
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({
      operationId: "op-1",
      replayed: true,
      undoAvailable: false,
      result: { ok: true },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      workspaceId: WID,
      actorUserId: "u-1",
      metadata: { idempotencyKey: "k-1" },
    });
  });

  it("maps command errors onto the documented problems", async () => {
    for (const [code, status] of [
      ["FORBIDDEN", 403],
      ["VERSION_CONFLICT", 409],
      ["IDEMPOTENCY_KEY_REUSED", 409],
      ["UNDO_CONFLICT", 409],
      ["INVARIANT_VIOLATION", 422],
    ] as const) {
      const mapped = await handleExecuteCommand("accounts.recordBalance", body(), {
        workspaceId: WID,
        actorUserId: null,
        registry: new Map([
          [
            "accounts.recordBalance",
            registration(() => {
              throw new CommandError(code, "nope");
            }),
          ],
        ]),
      });
      expect(mapped.status).toBe(status);
      expect(((await mapped.json()) as { code: string }).code).toBe(code);
    }
  });
});

describe("recordBalanceInputSchema", () => {
  it("accepts signed minor units and null cutoffs", () => {
    expect(
      recordBalanceInputSchema.safeParse({
        accountId: "22222222-2222-7222-8222-222222222222",
        observedAt: "2026-08-15T12:00:00Z",
        currentAmountMinor: "-500",
        currencyCode: "eur",
        source: "manual",
        cutoffDate: null,
      }).success,
    ).toBe(true);
    expect(
      recordBalanceInputSchema.safeParse({ accountId: "x", currentAmountMinor: "1.5" }).success,
    ).toBe(false);
  });
});

describe("correction command input schemas", () => {
  const txnId = "22222222-2222-7222-8222-222222222222";
  const catId = "33333333-3333-7333-8333-333333333333";

  it("accepts correction payloads and null clears", () => {
    expect(setCategoryInputSchema.safeParse({ transactionId: txnId, categoryId: catId }).success).toBe(
      true,
    );
    expect(setCategoryInputSchema.safeParse({ transactionId: txnId, categoryId: null }).success).toBe(
      true,
    );
    expect(
      setCounterpartyInputSchema.safeParse({ transactionId: txnId, counterpartyName: "Lidl" })
        .success,
    ).toBe(true);
    expect(
      addTagsInputSchema.safeParse({ transactionId: txnId, tags: ["food", "germany"] }).success,
    ).toBe(true);
    expect(setNoteInputSchema.safeParse({ transactionId: txnId, note: null }).success).toBe(true);
    expect(
      excludeFromAnalyticsInputSchema.safeParse({ transactionId: txnId, excluded: true }).success,
    ).toBe(true);
  });

  it("rejects bad ids, empty tag lists, and oversized values", () => {
    expect(setCategoryInputSchema.safeParse({ transactionId: "x", categoryId: catId }).success).toBe(
      false,
    );
    expect(addTagsInputSchema.safeParse({ transactionId: txnId, tags: [] }).success).toBe(false);
    expect(
      addTagsInputSchema.safeParse({ transactionId: txnId, tags: ["x".repeat(41)] }).success,
    ).toBe(false);
    expect(setNoteInputSchema.safeParse({ transactionId: txnId, note: "x".repeat(2001) }).success).toBe(
      false,
    );
    expect(
      excludeFromAnalyticsInputSchema.safeParse({ transactionId: txnId, excluded: "yes" }).success,
    ).toBe(false);
  });

  it("registers all six correction commands", () => {
    const registry = createDrizzleCommandRegistry();
    for (const name of [
      "transactions.setCategory",
      "transactions.setCounterparty",
      "transactions.addTags",
      "transactions.removeTags",
      "transactions.setNote",
      "transactions.excludeFromAnalytics",
    ]) {
      expect(registry.has(name)).toBe(true);
    }
  });

  it("marks corrections undoable and undo itself not", () => {
    const registry = createDrizzleCommandRegistry();
    for (const name of [
      "transactions.setCategory",
      "transactions.setCounterparty",
      "transactions.addTags",
      "transactions.removeTags",
      "transactions.setNote",
      "transactions.excludeFromAnalytics",
    ]) {
      expect(registry.get(name)?.undoAvailable).toBe(true);
    }
    const undo = registry.get("operations.undo");
    expect(undo).toBeDefined();
    expect(undo?.undoAvailable ?? false).toBe(false);
    expect(undo?.inputSchema.safeParse({ operationId: "ws:transactions.setNote:k" }).success).toBe(
      true,
    );
    expect(undo?.inputSchema.safeParse({ operationId: "" }).success).toBe(false);
  });
});

describe("manual command input schemas", () => {
  it("accepts a cash wallet and a cash purchase", () => {
    expect(
      createManualAccountInputSchema.safeParse({ name: "Cash wallet", currencyCode: "EUR" })
        .success,
    ).toBe(true);
    expect(
      createManualTransactionInputSchema.safeParse({
        accountId: "22222222-2222-7222-8222-222222222222",
        effectiveDate: "2026-08-16",
        description: "Cash coffee",
        amountMinor: "1500",
        currencyCode: "EUR",
        direction: "debit",
      }).success,
    ).toBe(true);
  });

  it("rejects blank names, float amounts, and bad directions", () => {
    expect(
      createManualAccountInputSchema.safeParse({ name: "", currencyCode: "EUR" }).success,
    ).toBe(false);
    expect(
      createManualTransactionInputSchema.safeParse({
        accountId: "22222222-2222-7222-8222-222222222222",
        effectiveDate: "16.08.2026",
        description: "x",
        amountMinor: "15.00",
        currencyCode: "EUR",
        direction: "OUTFLOW",
      }).success,
    ).toBe(false);
  });
});
