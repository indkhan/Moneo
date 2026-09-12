import { describe, expect, it } from "vitest";
import {
  buildClaimSql,
  CLAIM_SQL,
  dispatchOutboxBatch,
  outboxJobId,
  toJobData,
  type OutboxEventRow,
  type OutboxStore,
  type OutboxTransport,
} from "./outbox.js";

/**
 * Issue 2.5 — transactional outbox dispatcher.
 *
 * Proves the claim query shape, deterministic job ids, duplicate-publish
 * safety (same id twice = one queue job), crash-between-publish-and-mark
 * recovery (redelivery under the same id = one business effect), poison
 * events not blocking the batch, and limit validation.
 */

function row(id: string, overrides: Partial<OutboxEventRow> = {}): OutboxEventRow {
  return {
    id,
    workspaceId: "ws-1",
    aggregateType: "widget",
    aggregateId: "w1",
    eventType: "widget.renamed",
    payload: { version: 2 },
    attempts: 0,
    ...overrides,
  };
}

/** Fake store: FIFO claim over due rows, explicit published/error books. */
function memoryStore(initial: OutboxEventRow[] = []) {
  const pending = [...initial];
  const published: string[] = [];
  const errors = new Map<string, string>();
  const store: OutboxStore & { published: string[]; errors: Map<string, string> } = {
    published,
    errors,
    claim: (limit: number) => Promise.resolve(pending.splice(0, limit)),
    markPublished: (ids: string[]) => {
      published.push(...ids);
      return Promise.resolve();
    },
    markDispatchError: (id: string, message: string) => {
      errors.set(id, message);
      // The row stays claimable: requeue at the back for the next tick.
      const original = initial.find((r) => r.id === id);
      if (original) {
        pending.push(original);
      }
      return Promise.resolve();
    },
  };
  return store;
}

/** Fake transport: upsert by job id (BullMQ `jobId` semantics). */
function memoryTransport() {
  const jobs = new Map<string, object>();
  const publishCalls: string[] = [];
  const transport: OutboxTransport & {
    jobs: Map<string, object>;
    publishCalls: string[];
    failOn?: Set<string>;
  } = {
    jobs,
    publishCalls,
    publish: (jobId: string, data: object) => {
      publishCalls.push(jobId);
      if (transport.failOn?.has(jobId)) {
        return Promise.reject(new Error(`transport down for ${jobId}`));
      }
      if (!jobs.has(jobId)) {
        jobs.set(jobId, data);
      }
      return Promise.resolve();
    },
  };
  return transport;
}

describe("outbox dispatcher", () => {
  it("claims with FOR UPDATE SKIP LOCKED over due pending rows, oldest first", () => {
    expect(CLAIM_SQL).toContain("FOR UPDATE SKIP LOCKED");
    expect(CLAIM_SQL).toContain("status = 'pending'");
    expect(CLAIM_SQL).toContain("next_attempt_at <= now()");
    expect(CLAIM_SQL).toContain("ORDER BY created_at ASC");
    expect(CLAIM_SQL).toContain("LIMIT $1");
    // No workspace filter: one dispatcher tick sweeps every tenant (each row
    // still carries its workspace id into the job payload for scoped work).
    expect(CLAIM_SQL).not.toContain("workspace_id =");

    const query = buildClaimSql(25);
    expect(query).toEqual({ text: CLAIM_SQL, values: [25] });
  });

  it("rejects non-positive claim limits", () => {
    for (const bad of [0, -3, 1.5, Number.NaN]) {
      expect(() => buildClaimSql(bad)).toThrow(RangeError);
    }
  });

  it("derives deterministic BullMQ job ids from event ids", () => {
    expect(outboxJobId("evt-1")).toBe("outbox:evt-1");
    expect(outboxJobId("evt-1")).toBe(outboxJobId("evt-1"));
    expect(outboxJobId("evt-1")).not.toBe(outboxJobId("evt-2"));
  });

  it("maps rows to job payloads carrying the tenant scope", () => {
    expect(toJobData(row("e1"))).toEqual({
      eventId: "e1",
      workspaceId: "ws-1",
      aggregateType: "widget",
      aggregateId: "w1",
      eventType: "widget.renamed",
      payload: { version: 2 },
    });
  });

  it("publishes a batch and marks it published", async () => {
    const store = memoryStore([row("e1"), row("e2")]);
    const transport = memoryTransport();

    const outcome = await dispatchOutboxBatch(store, transport, 25);

    expect(outcome).toEqual({ claimed: 2, published: 2, failed: 0 });
    expect(transport.publishCalls).toEqual(["outbox:e1", "outbox:e2"]);
    expect([...transport.jobs.keys()]).toEqual(["outbox:e1", "outbox:e2"]);
    expect(store.published).toEqual(["e1", "e2"]);
  });

  it("duplicate publish is safe: same event twice resolves to one queue job", async () => {
    const transport = memoryTransport();
    const data = toJobData(row("e1"));

    await transport.publish(outboxJobId("e1"), data);
    await transport.publish(outboxJobId("e1"), data);

    expect(transport.jobs.size).toBe(1);
    expect(transport.jobs.get("outbox:e1")).toEqual(data);
  });

  it("crash between publish and mark-published recovers to one business effect", async () => {
    // Tick 1: publish succeeds, the process dies before markPublished.
    const transport = memoryTransport();
    const doomed = memoryStore([row("e1")]);
    const crashingMark = {
      ...doomed,
      markPublished: (_ids: string[]): Promise<void> =>
        Promise.reject(new Error("process crashed")),
    };
    // Publish happened (job exists in the transport)…
    await expect(dispatchOutboxBatch(crashingMark, transport, 25)).rejects.toThrow(
      "process crashed",
    );
    expect(transport.jobs.has("outbox:e1")).toBe(true);
    expect(doomed.published).toEqual([]);

    // …tick 2 (replacement dispatcher): the row is still claimable, the
    // republish upserts onto the SAME job id, and the consumer (Issue 2.6)
    // dedupes by that id — the downstream effect below runs exactly once.
    const redelivered = memoryStore([row("e1")]);
    const effects: string[] = [];
    const seenJobIds = new Set<string>();
    const consumer = (jobId: string): void => {
      if (!seenJobIds.has(jobId)) {
        seenJobIds.add(jobId);
        effects.push(jobId);
      }
    };
    await dispatchOutboxBatch(redelivered, transport, 25);
    for (const jobId of transport.publishCalls) {
      consumer(jobId);
    }
    consumer("outbox:e1"); // the duplicated delivery
    expect(effects).toEqual(["outbox:e1"]);
    expect(redelivered.published).toEqual(["e1"]);
  });

  it("a poison event is recorded without blocking the rest of the batch", async () => {
    const store = memoryStore([row("bad"), row("good")]);
    const transport = memoryTransport();
    transport.failOn = new Set(["outbox:bad"]);

    const outcome = await dispatchOutboxBatch(store, transport, 25);

    expect(outcome).toEqual({ claimed: 2, published: 1, failed: 1 });
    expect(store.published).toEqual(["good"]);
    expect(store.errors.get("bad")).toBe("transport down for outbox:bad");
    expect(transport.jobs.has("outbox:good")).toBe(true);
    expect(transport.jobs.has("outbox:bad")).toBe(false);
  });

  it("claims at most the requested limit per tick", async () => {
    const store = memoryStore([row("e1"), row("e2"), row("e3")]);
    const transport = memoryTransport();
    const outcome = await dispatchOutboxBatch(store, transport, 2);
    expect(outcome.claimed).toBe(2);
    expect(store.published).toEqual(["e1", "e2"]);
  });

  it("marks nothing when the batch is empty", async () => {
    const store = memoryStore();
    const transport = memoryTransport();
    let marked = false;
    const outcome = await dispatchOutboxBatch(
      {
        ...store,
        markPublished: (_ids: string[]) => {
          marked = true;
          return Promise.resolve();
        },
      },
      transport,
      25,
    );
    expect(outcome).toEqual({ claimed: 0, published: 0, failed: 0 });
    expect(marked).toBe(false);
  });
});
