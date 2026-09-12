import { describe, expect, it } from "vitest";
import { DomainError } from "@moneo/shared/problem";
import {
  createMemoryMatchStore,
  createResolveMatchCommand,
  decideRowForImport,
  normalizeMatchDescription,
  type MatchRowInput,
} from "./matching.js";
import { createMemoryCommandStore, executeCommand } from "./commands.js";
import type { MappedPreviewRow } from "./mapping.js";

/**
 * Issue 4.11 — matching domain (memory store: no I/O).
 *
 * Proves the trust ladder: confidently new rows are accepted; retries hit
 * identity; trusted external keys merge onto the existing canonical row
 * with an auto decision row; fuzzy near-matches stage as pending WITHOUT
 * linking; identical legitimate rows stay distinct; and `matches.resolve`
 * links (preserving the canonical row) or keeps distinct (new canonical),
 * idempotently, with audit and outbox output.
 */

function row(overrides: Partial<MappedPreviewRow> = {}): MappedPreviewRow {
  return {
    rowNumber: 1,
    date: "2026-08-15",
    description: "COFFEE BAR",
    amountMinor: "350",
    currency: "EUR",
    direction: "debit",
    account: "Everyday",
    ...overrides,
  };
}

function input(overrides: Partial<MatchRowInput> = {}): MatchRowInput {
  return {
    workspaceId: "ws-1",
    dataSourceId: "ds-1",
    importId: "imp-1",
    sourceAccountId: "src-acct-1",
    sourceTransactionId: "src-txn-1",
    sourceAccountLabel: "Everyday",
    row: row(),
    ...overrides,
  };
}

describe("normalizeMatchDescription", () => {
  it("folds case, punctuation, and spacing", () => {
    expect(normalizeMatchDescription("COFFEE BAR")).toBe(normalizeMatchDescription("Coffee  Bar!"));
    expect(normalizeMatchDescription("Café Müller")).toBe("cafemuller");
  });
});

describe("decideRowForImport", () => {
  it("accepts confidently new rows and matches their retry", async () => {
    const store = createMemoryMatchStore();
    const first = await decideRowForImport(store, input());
    expect(first.disposition).toBe("accepted");
    expect(first.transactionId).not.toBeNull();
    expect(first.candidateIds).toEqual([]);

    const retry = await decideRowForImport(store, input());
    expect(retry.disposition).toBe("matched");
    expect(retry.transactionId).toBe(first.transactionId);
    expect(store.transactions()).toHaveLength(1);
  });

  it("merges trusted external keys onto the existing canonical row", async () => {
    const store = createMemoryMatchStore();
    const seeded = await store.seedCanonical({
      workspaceId: "ws-1",
      dataSourceId: "ds-1",
      sourceTransactionId: "src-old",
      externalId: "bank-txn-9",
      effectiveDate: "2026-08-15",
      amountMinor: "350",
      currencyCode: "EUR",
      description: "COFFEE BAR",
    });
    const outcome = await decideRowForImport(
      store,
      input({ sourceTransactionId: "src-new", externalId: "bank-txn-9" }),
    );
    expect(outcome.disposition).toBe("matched");
    expect(outcome.transactionId).toBe(seeded.transactionId);
    expect(store.transactions()).toHaveLength(1);
    const auto = store.candidates().find((c) => c.sourceTransactionId === "src-new");
    expect(auto).toMatchObject({
      matchRule: "trusted-external-id",
      confidence: "auto",
      status: "linked",
    });
  });

  it("stages fuzzy near-matches as pending without linking", async () => {
    const store = createMemoryMatchStore();
    await store.seedCanonical({
      workspaceId: "ws-1",
      dataSourceId: "ds-1",
      sourceTransactionId: "src-august",
      effectiveDate: "2026-08-15",
      amountMinor: "350",
      currencyCode: "EUR",
      description: "Coffee Bar!",
    });
    const outcome = await decideRowForImport(
      store,
      input({ importId: "imp-2", sourceTransactionId: "src-september" }),
    );
    expect(outcome.disposition).toBe("pending");
    expect(outcome.transactionId).toBeNull();
    expect(outcome.candidateIds).toHaveLength(1);
    // Nothing linked: the August canonical stands alone.
    expect(store.transactions()).toHaveLength(1);
    expect(await store.findTransactionIdBySource("src-september")).toBeNull();
  });

  it("keeps two legitimate identical purchases distinct", async () => {
    const store = createMemoryMatchStore();
    const first = await decideRowForImport(store, input());
    expect(first.disposition).toBe("accepted");
    // Same file, second identical row: staged for review, never merged.
    const second = await decideRowForImport(
      store,
      input({ sourceTransactionId: "src-txn-2", row: row({ rowNumber: 2 }) }),
    );
    expect(second.disposition).toBe("pending");
    expect(store.transactions()).toHaveLength(1);
    expect(store.candidates()).toHaveLength(1);
  });

  it("rejects bad data as a rejected row, not a retry", async () => {
    const store = createMemoryMatchStore();
    await expect(
      decideRowForImport(store, input({ row: row({ amountMinor: "0" }) })),
    ).rejects.toThrow(DomainError);
    expect(store.transactions()).toHaveLength(0);
  });
});

describe("createResolveMatchCommand", () => {
  async function staged() {
    const store = createMemoryMatchStore();
    await store.seedCanonical({
      workspaceId: "ws-1",
      dataSourceId: "ds-1",
      sourceTransactionId: "src-august",
      effectiveDate: "2026-08-15",
      amountMinor: "350",
      currencyCode: "EUR",
      description: "COFFEE BAR",
    });
    const outcome = await decideRowForImport(
      store,
      input({ importId: "imp-2", sourceTransactionId: "src-september" }),
    );
    return { store, candidateId: outcome.candidateIds[0] as string };
  }

  const ctxFor = (key: string) => ({ workspaceId: "ws-1", actorUserId: null, idempotencyKey: key });

  it("links to the existing row without touching its corrections", async () => {
    const { store, candidateId } = await staged();
    const command = createResolveMatchCommand(store);
    const commandStore = createMemoryCommandStore();
    const before = store.transactions().length;
    const outcome = await executeCommand(
      command,
      ctxFor("r-1"),
      { candidateId, decision: "link" },
      commandStore,
    );
    expect(outcome.result.decision).toBe("link");
    expect(outcome.result.duplicate).toBe(false);
    // No new canonical: the September source merged onto August's row.
    expect(store.transactions()).toHaveLength(before);
    expect(await store.findTransactionIdBySource("src-september")).toBe(
      outcome.result.transactionId,
    );
    const recorded = commandStore.outbox()[0];
    expect(recorded).toMatchObject({ eventType: "match.resolved" });

    // Retrying the decision converges (same key replays, fresh key duplicates safely).
    const replay = await executeCommand(
      command,
      ctxFor("r-1"),
      { candidateId, decision: "link" },
      commandStore,
    );
    expect(replay.replayed).toBe(true);
    await expect(
      executeCommand(command, ctxFor("r-2"), { candidateId, decision: "link" }, commandStore),
    ).rejects.toMatchObject({ code: "INVARIANT_VIOLATION" });
  });

  it("keeps rows distinct as a new canonical with its own link", async () => {
    const { store, candidateId } = await staged();
    const command = createResolveMatchCommand(store);
    const outcome = await executeCommand(
      command,
      ctxFor("r-1"),
      { candidateId, decision: "distinct" },
      createMemoryCommandStore(),
    );
    expect(outcome.result.decision).toBe("distinct");
    expect(store.transactions()).toHaveLength(2);
    expect(await store.findTransactionIdBySource("src-september")).toBe(
      outcome.result.transactionId,
    );
  });

  it("refuses foreign candidates without disclosing them", async () => {
    const { store } = await staged();
    const command = createResolveMatchCommand(store);
    await expect(
      executeCommand(
        command,
        { workspaceId: "ws-other", actorUserId: null, idempotencyKey: "r-x" },
        { candidateId: "cand-1001", decision: "link" },
        createMemoryCommandStore(),
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
