import { describe, expect, it } from "vitest";
import { createPgOutboxStore } from "./outbox-store.js";

describe("PostgreSQL outbox store", () => {
  it("uses only the narrow dispatcher functions", async () => {
    const calls: Array<{ text: string; values: unknown[] | undefined }> = [];
    const pool = {
      query: (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        return Promise.resolve({
          rows: text.includes("claim_outbox_events")
            ? [
                {
                  id: "e1",
                  workspace_id: "w1",
                  aggregate_type: "job",
                  aggregate_id: "j1",
                  event_type: "job.ready",
                  payload: {},
                  attempts: 1,
                },
              ]
            : [],
        });
      },
    };
    const store = createPgOutboxStore(pool);

    expect(await store.claim(25)).toHaveLength(1);
    await store.markPublished(["00000000-0000-0000-0000-000000000001"]);
    await store.markDispatchError("00000000-0000-0000-0000-000000000001", "offline");

    expect(calls.map((call) => call.text)).toEqual([
      "SELECT * FROM claim_outbox_events($1)",
      "SELECT mark_outbox_events_published($1::uuid[])",
      "SELECT retry_outbox_event($1::uuid, $2::text)",
    ]);
    expect(calls.every((call) => !call.text.includes("UPDATE outbox_events"))).toBe(true);
  });
});
