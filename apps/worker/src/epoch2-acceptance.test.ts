import { describe, expect, it } from "vitest";
import { createMemoryCommandStore, executeCommand, type CommandDefinition } from "@moneo/finance";
import { dispatchOutboxBatch, type OutboxEventRow } from "./outbox.js";
import { runDurableJob, type DurableJob, type JobHandler, type JobStore } from "./job-lifecycle.js";
import { createRetryDecider } from "./retry.js";

/**
 * Epoch 2 acceptance: one business effect, complete audit trail,
 * understandable attempt history.
 *
 * Simulates the exact gate sequence from the epoch contract:
 *   1. command succeeds (audit + outbox written atomically),
 *   2. outbox publish duplicated (same event published twice),
 *   3. worker crashes mid-execution (transient failure, attempt recorded),
 *   4. same queue job delivered twice (redelivery after success).
 *
 * Expected: the widget moves exactly one version, the audit trail holds the
 * full story, and the downstream effect runs exactly once.
 */

interface Widget {
  version: number;
  label: string;
}

describe("epoch 2 acceptance", () => {
  it("command → duplicate publish → crash → redelivery yields one effect", async () => {
    // Canonical state (PostgreSQL in production; a Map here).
    const widgets = new Map<string, Widget>([["w1", { version: 1, label: "Old" }]]);
    const commandStore = createMemoryCommandStore();

    const rename: CommandDefinition<Widget, { id: string; label: string }, { label: string }> = {
      name: "widgets.rename",
      authorize: () => {},
      loadState: (_ctx, input) => ({ ...widgets.get(input.id)! }),
      currentVersionOf: (state) => state.version,
      mutate: (state, input) => {
        const next = { version: state.version + 1, label: input.label };
        widgets.set(input.id, next);
        return {
          resultingVersion: next.version,
          result: { label: next.label },
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

    // 1. Command succeeds.
    const outcome = await executeCommand(
      rename,
      { workspaceId: "ws-1", actorUserId: "user-1", idempotencyKey: "rename-1" },
      { id: "w1", label: "New" },
      commandStore,
    );
    expect(outcome.replayed).toBe(false);
    expect(outcome.resultingVersion).toBe(2);
    expect(commandStore.audit()).toHaveLength(1);
    expect(commandStore.outbox()).toHaveLength(1);

    // Outbox row the dispatcher would claim (Issue 2.1 → 2.5 handoff).
    const outboxRow: OutboxEventRow = {
      id: "evt-1",
      workspaceId: "ws-1",
      aggregateType: "widget",
      aggregateId: "w1",
      eventType: "widget.renamed",
      payload: { label: "New", version: 2 },
      attempts: 0,
    };

    // Transport: BullMQ keyed by deterministic job id (upsert = dedupe).
    const queueJobs = new Map<string, object>();
    const transport = {
      publish: (jobId: string, data: object) => {
        if (!queueJobs.has(jobId)) {
          queueJobs.set(jobId, data);
        }
        return Promise.resolve();
      },
    };

    // Durable job row for the downstream fan-out (Issue 2.4 → 2.6 handoff).
    const durable: DurableJob = {
      id: "job-1",
      workspaceId: "ws-1",
      type: "widget-index.update",
      status: "queued",
      attempts: 0,
      maxAttempts: 3,
      payload: { eventId: "evt-1", widgetId: "w1" },
    };
    const attempts: { n: number; status: string; error: string | null }[] = [];
    const jobStore: JobStore = {
      load: (id) => Promise.resolve(id === durable.id ? { ...durable } : null),
      createAttempt: (_id, n) => {
        attempts.push({ n, status: "started", error: null });
        return Promise.resolve();
      },
      markRunning: () => {
        durable.status = "running";
        return Promise.resolve();
      },
      heartbeat: () => Promise.resolve(),
      finishAttempt: (_id, n, status, error) => {
        const attempt = attempts.find((a) => a.n === n);
        attempt!.status = status;
        attempt!.error = error ? (error as { message: string }).message : null;
        return Promise.resolve();
      },
      markSucceeded: () => {
        durable.status = "succeeded";
        return Promise.resolve();
      },
      markRetryable: (_id, n) => {
        durable.status = "queued";
        durable.attempts = n;
        return Promise.resolve();
      },
      markFailed: (_id, n) => {
        durable.status = "failed";
        durable.attempts = n;
        return Promise.resolve();
      },
      markCancelled: () => {
        durable.status = "cancelled";
        return Promise.resolve();
      },
    };

    // Downstream effect: idempotent on the outbox event id.
    const downstreamEffects: string[] = [];
    const seenEvents = new Set<string>();
    let crashNext = true;
    const handlers = new Map<string, JobHandler>([
      [
        "widget-index.update",
        (payload) => {
          if (crashNext) {
            crashNext = false;
            throw new Error("socket hang up mid-index");
          }
          const eventId = payload["eventId"] as string;
          if (!seenEvents.has(eventId)) {
            seenEvents.add(eventId);
            downstreamEffects.push(eventId);
          }
          return Promise.resolve({ indexed: true });
        },
      ],
    ]);
    const decide = createRetryDecider(
      { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 60_000 },
      () => 0,
    );

    // 2. Outbox publish duplicated: the dispatcher delivers the same event twice.
    const claimOnce = (rows: OutboxEventRow[]) => ({
      claim: () => Promise.resolve(rows.splice(0, rows.length)),
      markPublished: () => Promise.resolve(),
      markDispatchError: () => Promise.resolve(),
    });
    await dispatchOutboxBatch(claimOnce([{ ...outboxRow }]), transport, 25);
    await dispatchOutboxBatch(claimOnce([{ ...outboxRow }]), transport, 25);
    expect([...queueJobs.keys()]).toEqual(["outbox-evt-1"]);

    // 3. Worker crashes mid-execution: transient failure is recorded + requeued.
    const crashed = await runDurableJob(jobStore, handlers, decide, "job-1", "worker-a");
    expect(crashed).toEqual({ status: "failed", attemptNumber: 1, retried: true });
    expect(downstreamEffects).toEqual([]);

    // Retry succeeds: exactly one downstream effect.
    const recovered = await runDurableJob(jobStore, handlers, decide, "job-1", "worker-a");
    expect(recovered).toEqual({ status: "succeeded", attemptNumber: 2 });
    expect(downstreamEffects).toEqual(["evt-1"]);

    // 4. Same queue job delivered twice after success: terminal → skip, no new attempt.
    const redelivered = await runDurableJob(jobStore, handlers, decide, "job-1", "worker-b");
    expect(redelivered).toEqual({ status: "skipped", reason: "terminal", attemptNumber: null });

    // Gate expectations.
    expect(widgets.get("w1")).toEqual({ version: 2, label: "New" }); // one business effect
    expect(commandStore.audit()).toHaveLength(1); // complete audit trail
    expect(commandStore.audit()[0]).toMatchObject({
      entityType: "widget",
      entityId: "w1",
      oldValue: { label: "Old" },
      newValue: { label: "New" },
    });
    expect(attempts).toEqual([
      { n: 1, status: "failed", error: "socket hang up mid-index" },
      { n: 2, status: "succeeded", error: null },
    ]); // understandable attempt history
    expect(downstreamEffects).toEqual(["evt-1"]); // duplicate delivery, one effect
  });
});
