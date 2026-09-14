import { describe, expect, it } from "vitest";
import { createMemoryImportStore } from "./import-workflow.js";
import { createImportHandlerWithStore } from "./import-adapter.js";

describe("production import handler boundary", () => {
  it("creates durable import metadata before processing quarantined bytes", async () => {
    const csv = new TextEncoder().encode("Date,Description,Amount\n2026-08-01,Coffee,-2.50\n");
    const memory = createMemoryImportStore({ objects: { "quarantine/key/file.csv": csv } });
    const order: string[] = [];
    const handler = createImportHandlerWithStore(() => ({
      ...memory,
      ensureImport: () => {
        order.push("ensure");
        return Promise.resolve();
      },
      getObject: (key) => {
        order.push("read");
        return memory.getObject(key);
      },
    }));
    const result = await handler(
      {
        importId: "00000000-0000-4000-8000-000000000001",
        dataSourceId: "00000000-0000-4000-8000-000000000002",
        objectKey: "quarantine/key/file.csv",
        fileName: "file.csv",
        mapping: { date: 0, description: 1, amount: 2 },
      },
      {
        jobId: "job",
        workspaceId: "00000000-0000-4000-8000-000000000003",
        attemptNumber: 1,
        workerId: "worker",
        heartbeat: () => Promise.resolve(),
        isCancelled: () => Promise.resolve(false),
      },
    );
    expect(order.slice(0, 2)).toEqual(["ensure", "read"]);
    expect(result).toMatchObject({ rowCount: 1, newCount: 1 });
  });
});
