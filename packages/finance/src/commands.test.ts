import { describe, expect, it } from "vitest";
import {
  CommandError,
  createMemoryCommandStore,
  executeCommand,
  hashInput,
  operationIdFor,
  type CommandContext,
  type CommandDefinition,
  type CommandStore,
} from "./commands.js";

/**
 * Issue 2.2 — idempotent command executor.
 *
 * A synthetic versioned entity (`{ version, label }`) stands in for finance
 * rows until Epoch 4 exists. Every lifecycle step is asserted: order,
 * idempotent replay without re-mutation, key-reuse rejection, auth/version/
 * invariant failures with no partial effects, and audit/outbox linkage.
 */

interface Widget {
  version: number;
  label: string;
}

const baseCtx: CommandContext = {
  workspaceId: "ws-test",
  actorUserId: "user-test",
  idempotencyKey: "key-1",
};

function renameWidget(
  widgets: Map<string, Widget>,
  hooks: { steps?: string[]; mutateCalls?: { n: number } } = {},
): CommandDefinition<Widget, { id: string; label: string }, { id: string; label: string }> {
  return {
    name: "widgets.rename",
    authorize(ctx) {
      hooks.steps?.push("authorize");
      if (ctx.actorUserId === "banned") {
        throw new CommandError("FORBIDDEN", "actor is banned");
      }
    },
    loadState(_ctx, input) {
      hooks.steps?.push("load");
      const widget = widgets.get(input.id);
      if (!widget) {
        throw new CommandError("INVARIANT_VIOLATION", `unknown widget ${input.id}`);
      }
      return { ...widget };
    },
    currentVersionOf: (state) => state.version,
    checkInvariant(state, input) {
      hooks.steps?.push("invariant");
      if (input.label.length === 0) {
        throw new CommandError("INVARIANT_VIOLATION", "label must not be empty");
      }
      if (state.label === input.label) {
        throw new CommandError("INVARIANT_VIOLATION", "label is unchanged");
      }
    },
    mutate(state, input) {
      hooks.steps?.push("mutate");
      if (hooks.mutateCalls) {
        hooks.mutateCalls.n += 1;
      }
      const next = { version: state.version + 1, label: input.label };
      widgets.set(input.id, next);
      return {
        resultingVersion: next.version,
        result: { id: input.id, label: next.label },
        audit: {
          entityType: "widget",
          entityId: input.id,
          action: "widgets.rename",
          oldValue: { label: state.label },
          newValue: { label: next.label },
        },
        outbox: [
          {
            aggregateType: "widget",
            aggregateId: input.id,
            eventType: "widget.renamed",
            payload: { label: next.label, version: next.version },
          },
        ],
      };
    },
  };
}

describe("command executor lifecycle", () => {
  it("runs the full lifecycle in order and persists audit + outbox + result", async () => {
    const widgets = new Map([["w1", { version: 3, label: "Old" }]]);
    const steps: string[] = [];
    const store = createMemoryCommandStore();

    const outcome = await executeCommand(
      renameWidget(widgets, { steps }),
      { ...baseCtx, expectedVersion: 3 },
      { id: "w1", label: "New" },
      store,
    );

    expect(steps).toEqual(["authorize", "load", "invariant", "mutate"]);
    expect(outcome).toMatchObject({
      result: { id: "w1", label: "New" },
      resultingVersion: 4,
      operationId: operationIdFor("ws-test", "widgets.rename", "key-1"),
      replayed: false,
    });
    expect(widgets.get("w1")).toEqual({ version: 4, label: "New" });

    const claim = await store.readClaim("ws-test", "widgets.rename", "key-1");
    expect(claim?.status).toBe("succeeded");
    expect(claim?.result).toEqual({ id: "w1", label: "New" });
    expect(claim?.resultingVersion).toBe(4);

    expect(store.audit()).toHaveLength(1);
    expect(store.audit()[0]).toMatchObject({
      entityType: "widget",
      entityId: "w1",
      action: "widgets.rename",
      oldValue: { label: "Old" },
      newValue: { label: "New" },
      commandOperationId: outcome.operationId,
    });
    expect(store.outbox()).toEqual([
      {
        aggregateType: "widget",
        aggregateId: "w1",
        eventType: "widget.renamed",
        payload: { label: "New", version: 4 },
      },
    ]);
  });

  it("replays return the stored result without re-running mutate", async () => {
    const widgets = new Map([["w1", { version: 1, label: "A" }]]);
    const mutateCalls = { n: 0 };
    const store = createMemoryCommandStore();
    const def = renameWidget(widgets, { mutateCalls });
    const input = { id: "w1", label: "B" };

    const first = await executeCommand(def, baseCtx, input, store);
    const second = await executeCommand(def, baseCtx, input, store);

    expect(mutateCalls.n).toBe(1);
    expect(second.replayed).toBe(true);
    expect(second.result).toEqual(first.result);
    expect(second.operationId).toBe(first.operationId);
    expect(second.resultingVersion).toBe(2);
    // One business effect: the widget moved exactly one version.
    expect(widgets.get("w1")).toEqual({ version: 2, label: "B" });
    expect(store.audit()).toHaveLength(1);
    expect(store.outbox()).toHaveLength(1);
  });

  it("rejects the same key with different input (IDEMPOTENCY_KEY_REUSED)", async () => {
    const widgets = new Map([["w1", { version: 1, label: "A" }]]);
    const mutateCalls = { n: 0 };
    const store = createMemoryCommandStore();
    const def = renameWidget(widgets, { mutateCalls });

    await executeCommand(def, baseCtx, { id: "w1", label: "B" }, store);
    const error = await executeCommand(def, baseCtx, { id: "w1", label: "C" }, store).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).code).toBe("IDEMPOTENCY_KEY_REUSED");
    // The conflicting call never mutated: still exactly one effect.
    expect(mutateCalls.n).toBe(1);
    expect(widgets.get("w1")).toEqual({ version: 2, label: "B" });
  });

  it("scopes idempotency per command name and per workspace", async () => {
    const widgets = new Map([["w1", { version: 1, label: "A" }]]);
    const store = createMemoryCommandStore();
    const other: CommandDefinition<Widget, { id: string; label: string }, { ok: boolean }> = {
      name: "widgets.pin",
      authorize: () => {},
      loadState: () => ({ version: 1, label: "A" }),
      currentVersionOf: (s) => s.version,
      mutate: () => ({
        resultingVersion: 1,
        result: { ok: true },
        audit: { entityType: "widget", entityId: "w1", action: "widgets.pin" },
      }),
    };
    await executeCommand(renameWidget(widgets), baseCtx, { id: "w1", label: "B" }, store);
    // Same key, different command name: independent claim, runs fine.
    const pinned = await executeCommand(other, baseCtx, { id: "w1", label: "B" }, store);
    expect(pinned.replayed).toBe(false);
    // Same command + key in another workspace: independent claim, runs fine.
    const otherWs = await executeCommand(
      renameWidget(widgets),
      { ...baseCtx, workspaceId: "ws-other" },
      { id: "w1", label: "C" },
      store,
    );
    expect(otherWs.replayed).toBe(false);
  });

  it("denies unauthorized callers before claiming (no stored side effects)", async () => {
    const widgets = new Map([["w1", { version: 1, label: "A" }]]);
    const store = createMemoryCommandStore();
    const error = await executeCommand(
      renameWidget(widgets),
      { ...baseCtx, actorUserId: "banned" },
      { id: "w1", label: "B" },
      store,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).code).toBe("FORBIDDEN");
    expect(await store.readClaim("ws-test", "widgets.rename", "key-1")).toBeNull();
    expect(widgets.get("w1")).toEqual({ version: 1, label: "A" });
    expect(store.audit()).toHaveLength(0);
    expect(store.outbox()).toHaveLength(0);
  });

  it("rejects stale expected versions without mutating (VERSION_CONFLICT)", async () => {
    const widgets = new Map([["w1", { version: 5, label: "A" }]]);
    const mutateCalls = { n: 0 };
    const steps: string[] = [];
    const store = createMemoryCommandStore();
    const error = await executeCommand(
      renameWidget(widgets, { steps, mutateCalls }),
      { ...baseCtx, expectedVersion: 4 },
      { id: "w1", label: "B" },
      store,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommandError);
    const typed = error as CommandError;
    expect(typed.code).toBe("VERSION_CONFLICT");
    expect(typed.details).toMatchObject({ expectedVersion: 4, currentVersion: 5 });
    // Loaded state, but never validated or mutated.
    expect(steps).toEqual(["authorize", "load"]);
    expect(mutateCalls.n).toBe(0);
    expect(widgets.get("w1")).toEqual({ version: 5, label: "A" });
    expect(store.audit()).toHaveLength(0);
    expect(store.outbox()).toHaveLength(0);
    expect((await store.readClaim("ws-test", "widgets.rename", "key-1"))?.status).toBe("failed");
  });

  it("fails invariant violations without mutating or emitting", async () => {
    const widgets = new Map([["w1", { version: 1, label: "A" }]]);
    const mutateCalls = { n: 0 };
    const store = createMemoryCommandStore();
    const error = await executeCommand(
      renameWidget(widgets, { mutateCalls }),
      baseCtx,
      { id: "w1", label: "" },
      store,
    ).catch((e: unknown) => e);
    expect((error as CommandError).code).toBe("INVARIANT_VIOLATION");
    expect(mutateCalls.n).toBe(0);
    expect(widgets.get("w1")).toEqual({ version: 1, label: "A" });
    expect(store.audit()).toHaveLength(0);
    expect(store.outbox()).toHaveLength(0);
    expect((await store.readClaim("ws-test", "widgets.rename", "key-1"))?.status).toBe("failed");
  });

  it("marks the claim failed when mutate throws, and surfaces the error", async () => {
    const store = createMemoryCommandStore();
    const explosive: CommandDefinition<Widget, object, object> = {
      name: "widgets.explode",
      authorize: () => {},
      loadState: () => ({ version: 1, label: "A" }),
      currentVersionOf: (s) => s.version,
      mutate: () => {
        throw new Error("boom");
      },
    };
    await expect(executeCommand(explosive, baseCtx, {}, store)).rejects.toThrow("boom");
    expect((await store.readClaim("ws-test", "widgets.explode", "key-1"))?.status).toBe("failed");
  });

  it("requires workspace context and an idempotency key", async () => {
    const widgets = new Map([["w1", { version: 1, label: "A" }]]);
    const store = createMemoryCommandStore();
    const noWs = await executeCommand(
      renameWidget(widgets),
      { ...baseCtx, workspaceId: "" },
      { id: "w1", label: "B" },
      store,
    ).catch((e: unknown) => e);
    expect((noWs as CommandError).code).toBe("FORBIDDEN");
    const noKey = await executeCommand(
      renameWidget(widgets),
      { ...baseCtx, idempotencyKey: "" },
      { id: "w1", label: "B" },
      store,
    ).catch((e: unknown) => e);
    expect((noKey as CommandError).code).toBe("INVARIANT_VIOLATION");
  });

  it("ignores expectedVersion for unversioned entities", async () => {
    const store = createMemoryCommandStore();
    const def: CommandDefinition<object, object, { ok: boolean }> = {
      name: "ping",
      authorize: () => {},
      loadState: () => ({}),
      currentVersionOf: () => null,
      mutate: () => ({
        resultingVersion: 0,
        result: { ok: true },
        audit: { entityType: "ping", entityId: "p", action: "ping" },
      }),
    };
    const outcome = await executeCommand(
      def,
      { ...baseCtx, expectedVersion: 99 },
      {},
      store,
    );
    expect(outcome.result).toEqual({ ok: true });
  });

  it("round-trips scalar results verbatim on replay", async () => {
    const store = createMemoryCommandStore();
    const def: CommandDefinition<object, object, number> = {
      name: "counter.bump",
      authorize: () => {},
      loadState: () => ({}),
      currentVersionOf: () => null,
      mutate: () => ({
        resultingVersion: 1,
        result: 41,
        audit: { entityType: "counter", entityId: "c", action: "counter.bump" },
      }),
    };
    const first = await executeCommand(def, baseCtx, {}, store);
    expect(first.result).toBe(41);
    const replay = await executeCommand(def, baseCtx, {}, store);
    expect(replay.replayed).toBe(true);
    expect(replay.result).toBe(41);
  });

  it("hashInput is stable for replay comparison", () => {
    expect(hashInput({ b: 1, a: 2 })).toBe(hashInput({ b: 1, a: 2 }));
    expect(hashInput({ a: 1 })).not.toBe(hashInput({ a: 2 }));
    expect(hashInput(undefined)).toBe("null");
  });

  it("withClaim surfaces concurrent-claim semantics to the store", async () => {
    const store = createMemoryCommandStore();
    let seen: unknown = "unset";
    await store.withClaim("w", "c", "k", "h", (existing) => {
      seen = existing;
      return Promise.resolve("first");
    });
    expect(seen).toBeNull();
    await store.withClaim("w", "c", "k", "h", (existing) => {
      seen = existing;
      return Promise.resolve("second");
    });
    expect((seen as { status: string }).status).toBe("claimed");
    const typed: CommandStore = store;
    expect(await typed.readClaim("w", "nope", "k")).toBeNull();
  });
});
