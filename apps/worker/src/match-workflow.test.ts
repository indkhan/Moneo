import { describe, expect, it } from "vitest";
import {
  createMemoryMatchStore,
  decideRowForImport,
  createResolveMatchCommand,
  type MatchRowInput,
} from "@moneo/finance";
import { createMemoryCommandStore, executeCommand } from "@moneo/finance";
import {
  createMemoryImportStore,
  runImportWorkflow,
  type CanonicalizeHook,
  type ImportJobInput,
} from "./import-workflow.js";
import type { HandlerContext } from "./job-lifecycle.js";

/**
 * Issue 4.11 — overlapping imports through the workflow hook.
 *
 * Proves the acceptance end to end with the memory stores: August followed
 * by August–September adds only confidently new rows (overlap stages as
 * pending, outside canonical totals); retrying either import has one
 * effect; two legitimate identical purchases stay distinct source rows;
 * and staged candidates resolve to linked or distinct canonicals. The
 * default (hookless) path is untouched — see import-workflow.test.ts.
 */

const WS = "11111111-1111-4111-8111-111111111111";
const DS = "22222222-2222-4222-8222-222222222222";

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

const CSV_MAPPING = {
  date: 0,
  description: 1,
  amount: 2,
  credit: null,
  debit: null,
  currency: null,
  direction: null,
  account: null,
  fee: null,
};

function csvInput(overrides: Partial<ImportJobInput> = {}): ImportJobInput {
  return {
    importId: "33333333-3333-4333-8333-333333333333",
    workspaceId: WS,
    dataSourceId: DS,
    objectKey: "quarantine/key/statement.csv",
    fileName: "august.csv",
    mapping: { ...CSV_MAPPING },
    defaultCurrency: "EUR",
    ...overrides,
  };
}

function liveCtx(): HandlerContext {
  return {
    jobId: "job-1",
    workspaceId: WS,
    attemptNumber: 1,
    workerId: "worker-1",
    heartbeat: () => Promise.resolve(),
    isCancelled: () => Promise.resolve(false),
  };
}

function matchHook(store: ReturnType<typeof createMemoryMatchStore>): CanonicalizeHook {
  return {
    canonicalize: (input) => {
      const args: MatchRowInput = {
        workspaceId: input.workspaceId,
        dataSourceId: input.dataSourceId,
        importId: input.importId,
        sourceAccountId: input.sourceAccountId,
        sourceTransactionId: input.sourceTransactionId,
        sourceAccountLabel: input.sourceAccountLabel,
        row: { ...input.row },
      };
      return decideRowForImport(store, args);
    },
  };
}

const AUGUST = [
  "date,description,amount",
  "2026-08-05,COFFEE BAR,3.50",
  "2026-08-12,BOOKSTORE,24.99",
  "2026-08-20,SALARY AUGUST,2500.00",
].join("\n");

const AUGUST_SEPTEMBER = [
  "date,description,amount",
  "2026-08-12,BOOKSTORE,24.99",
  "2026-08-20,SALARY AUGUST,2500.00",
  "2026-09-03,COFFEE BAR,3.50",
].join("\n");

describe("overlapping imports with the match hook", () => {
  it("adds only confidently new rows and stages overlap for review", async () => {
    const match = createMemoryMatchStore();
    const hooks = { canonicalize: matchHook(match) };
    // One store for both runs, like production's one database: source ids
    // never collide across imports, so matches are real fuzzy hits.
    const store = createMemoryImportStore({
      objects: {
        "quarantine/key/august.csv": bytesOf(AUGUST),
        "quarantine/key/september.csv": bytesOf(AUGUST_SEPTEMBER),
      },
    });
    const augustInput = csvInput({
      objectKey: "quarantine/key/august.csv",
      fileName: "august.csv",
      accountName: "Everyday",
    });
    const first = await runImportWorkflow(store, augustInput, liveCtx(), hooks);
    expect(first).toMatchObject({ rowCount: 3, newCount: 3, duplicateCount: 0, reviewCount: 0 });
    expect(first.newCount + first.duplicateCount + first.reviewCount + first.errorCount).toBe(
      first.rowCount,
    );

    const second = await runImportWorkflow(
      store,
      csvInput({
        importId: "44444444-4444-4444-8444-444444444444",
        objectKey: "quarantine/key/september.csv",
        fileName: "september.csv",
        accountName: "Everyday",
      }),
      liveCtx(),
      hooks,
    );
    expect(second).toMatchObject({ rowCount: 3, newCount: 1, duplicateCount: 0, reviewCount: 2 });
    expect(second.newCount + second.duplicateCount + second.reviewCount + second.errorCount).toBe(
      second.rowCount,
    );
    // Canonical totals hold 4 rows (3 + 1); the 2 overlapping rows are
    // staged outside totals until resolved.
    expect(match.transactions()).toHaveLength(4);
    expect(match.candidates().filter((c) => c.status === "pending")).toHaveLength(2);
  });

  it("retries either import with exactly one effect", async () => {
    const match = createMemoryMatchStore();
    const hooks = { canonicalize: matchHook(match) };
    const store = createMemoryImportStore({
      objects: { "quarantine/key/august.csv": bytesOf(AUGUST) },
    });
    const run = (importId: string) =>
      runImportWorkflow(
        store,
        csvInput({ importId, objectKey: "quarantine/key/august.csv", accountName: "Everyday" }),
        liveCtx(),
        hooks,
      );
    await run("55555555-5555-4555-8555-555555555555");
    const canonicals = match.transactions().length;
    const candidates = match.candidates().length;
    // Same import id retried: identical dispositions, no new rows or candidates.
    const retry = await run("55555555-5555-4555-8555-555555555555");
    expect(retry).toMatchObject({ newCount: 0, duplicateCount: 3, reviewCount: 0 });
    expect(match.transactions()).toHaveLength(canonicals);
    expect(match.candidates()).toHaveLength(candidates);
  });

  it("keeps two legitimate identical purchases as distinct source rows", async () => {
    const match = createMemoryMatchStore();
    const hooks = { canonicalize: matchHook(match) };
    const csv = [
      "date,description,amount",
      "2026-08-05,COFFEE BAR,3.50",
      "2026-08-05,COFFEE BAR,3.50",
    ].join("\n");
    const summary = await runImportWorkflow(
      createMemoryImportStore({ objects: { "quarantine/key/statement.csv": bytesOf(csv) } }),
      csvInput(),
      liveCtx(),
      hooks,
    );
    // First accepted, second staged — both preserved, nothing merged away.
    expect(summary).toMatchObject({ rowCount: 2, newCount: 1, reviewCount: 1 });
    expect(match.transactions()).toHaveLength(1);
    expect(match.candidates()).toHaveLength(1);
  });

  it("resolves staged rows to linked or distinct canonicals", async () => {
    const match = createMemoryMatchStore();
    const hooks = { canonicalize: matchHook(match) };
    const imports = createMemoryImportStore({
      objects: {
        "quarantine/key/august.csv": bytesOf(AUGUST),
        "quarantine/key/september.csv": bytesOf(AUGUST_SEPTEMBER),
      },
    });
    await runImportWorkflow(
      imports,
      csvInput({
        objectKey: "quarantine/key/august.csv",
        fileName: "august.csv",
        accountName: "Everyday",
      }),
      liveCtx(),
      hooks,
    );
    await runImportWorkflow(
      imports,
      csvInput({
        importId: "66666666-6666-4666-8666-666666666666",
        objectKey: "quarantine/key/september.csv",
        fileName: "september.csv",
        accountName: "Everyday",
      }),
      liveCtx(),
      hooks,
    );
    const command = createResolveMatchCommand(match);
    const store = createMemoryCommandStore();
    const pending = match.candidates().filter((c) => c.status === "pending");
    expect(pending).toHaveLength(2);

    // Link the bookstore overlap onto August's row: no new canonical.
    const linked = await executeCommand(
      command,
      { workspaceId: WS, actorUserId: null, idempotencyKey: "resolve-1" },
      { candidateId: (pending[0] as (typeof pending)[number]).id, decision: "link" },
      store,
    );
    expect(linked.result.decision).toBe("link");
    expect(match.transactions()).toHaveLength(4);

    // Keep the salary overlap distinct: deliberate second canonical.
    const distinct = await executeCommand(
      command,
      { workspaceId: WS, actorUserId: null, idempotencyKey: "resolve-2" },
      { candidateId: (pending[1] as (typeof pending)[number]).id, decision: "distinct" },
      store,
    );
    expect(distinct.result.decision).toBe("distinct");
    expect(match.transactions()).toHaveLength(5);
    expect(match.candidates().filter((c) => c.status === "pending")).toHaveLength(0);
  });
});
