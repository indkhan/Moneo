import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  CommandError,
  executeCommand,
  type CommandDefinition,
  type CommandMutation,
} from "@moneo/finance";
import * as schema from "./schema.js";
import { auditEvents, outboxEvents, workspaces } from "./schema.js";
import { createDrizzleCommandStore } from "./command-store.js";
import { createMigratedDb, one } from "./pglite-test-db.js";

/**
 * Issue 4.10 — Drizzle command store over the Issue 2.1 tables.
 *
 * Proves with a trivial counter command: first execution mutates once and
 * persists audit + outbox atomically; replay returns the stored result
 * without re-mutating; same key with different input is rejected loudly;
 * failures mark the claim so a retry re-executes cleanly.
 */

interface CounterState {
  runs: number;
}

const counterCommand: CommandDefinition<CounterState, { step: number }, { total: number }> = {
  name: "test.counter",
  authorize: () => {},
  loadState: (ctx) => ({ runs: (ctx as unknown as { runs?: number }).runs ?? 0 }),
  currentVersionOf: () => 7,
  mutate: (state, input) => {
    const total = state.runs + input.step;
    const mutation: CommandMutation<{ total: number }> = {
      resultingVersion: 8,
      result: { total },
      audit: {
        entityType: "counter",
        entityId: "c1",
        action: "test.counter",
        oldValue: { runs: state.runs },
        newValue: { total },
      },
      outbox: [
        {
          aggregateType: "counter",
          aggregateId: "c1",
          eventType: "counter.bumped",
          payload: { total },
        },
      ],
    };
    return mutation;
  },
};

describe("drizzle command store (issue 4.10)", () => {
  let pg!: PGlite;
  let ws!: string;

  beforeAll(async () => {
    pg = await createMigratedDb("0012_command_input_hash");
    const db = drizzlePglite(pg, { schema });
    ws = one(await db.insert(workspaces).values({ name: "Commands" }).returning()).id;
  });

  afterAll(async () => {
    await pg.close();
  });

  const ctxFor = (key: string, expectedVersion?: number | null) => ({
    workspaceId: ws,
    actorUserId: null,
    idempotencyKey: key,
    ...(expectedVersion !== undefined ? { expectedVersion } : {}),
  });

  it("executes once, persists audit + outbox, and replays verbatim", async () => {
    const db = drizzlePglite(pg, { schema });
    const store = createDrizzleCommandStore(db);
    const first = await executeCommand(counterCommand, ctxFor("k-1"), { step: 2 }, store);
    expect(first.result).toEqual({ total: 2 });
    expect(first.resultingVersion).toBe(8);
    expect(first.replayed).toBe(false);
    expect(first.operationId).toBe(`${ws}:test.counter:k-1`);

    const replay = await executeCommand(counterCommand, ctxFor("k-1"), { step: 2 }, store);
    expect(replay.result).toEqual({ total: 2 });
    expect(replay.replayed).toBe(true);

    expect(
      (await db.select().from(auditEvents)).filter((a) => a.action === "test.counter"),
    ).toHaveLength(1);
    expect(
      (await db.select().from(outboxEvents)).filter((o) => o.eventType === "counter.bumped"),
    ).toHaveLength(1);
  });

  it("rejects same key with different input, and stale versions", async () => {
    const db = drizzlePglite(pg, { schema });
    const store = createDrizzleCommandStore(db);
    await executeCommand(counterCommand, ctxFor("k-2"), { step: 1 }, store);
    await expect(
      executeCommand(counterCommand, ctxFor("k-2"), { step: 9 }, store),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    await expect(
      executeCommand(counterCommand, ctxFor("k-3", 3), { step: 1 }, store),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    const ok = await executeCommand(counterCommand, ctxFor("k-3", 7), { step: 1 }, store);
    expect(ok.result).toEqual({ total: 1 });
  });

  it("marks failures so a retry re-executes cleanly", async () => {
    const db = drizzlePglite(pg, { schema });
    const store = createDrizzleCommandStore(db);
    const failing: CommandDefinition<CounterState, { step: number }, { total: number }> = {
      ...counterCommand,
      mutate: () => {
        throw new CommandError("INVARIANT_VIOLATION", "boom");
      },
    };
    await expect(executeCommand(failing, ctxFor("k-4"), { step: 1 }, store)).rejects.toThrow(
      "boom",
    );
    const claim = await store.readClaim(ws, "test.counter", "k-4");
    expect(claim?.status).toBe("failed");
    const retry = await executeCommand(counterCommand, ctxFor("k-4"), { step: 1 }, store);
    expect(retry.result).toEqual({ total: 1 });
    expect(retry.replayed).toBe(false);
  });
});
