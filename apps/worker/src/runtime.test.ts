import { describe, expect, it } from "vitest";
import { createBullMqOutboxTransport, QUEUE_NAME } from "./runtime.js";

describe("worker runtime", () => {
  it("declares a stable maintenance queue name", () => {
    expect(QUEUE_NAME).toBe("moneo-maintenance");
  });

  it("publishes outbox deliveries with a BullMQ-safe deterministic id", async () => {
    const calls: unknown[][] = [];
    const queue = {
      add: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve();
      },
    };
    const transport = createBullMqOutboxTransport(queue);
    const data = {
      eventId: "evt-1",
      workspaceId: "ws-1",
      aggregateType: "background_job",
      aggregateId: "job-1",
      eventType: "job.ready",
      payload: { backgroundJobId: "job-1" },
    };

    await transport.publish("outbox-evt-1", data);

    expect(calls).toEqual([["outbox-delivery", data, { jobId: "outbox-evt-1" }]]);
  });
});
