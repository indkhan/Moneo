import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createMigratedDb, tableNames } from "./pglite-test-db.js";

describe("AI conversation and run persistence", () => {
  let pg!: PGlite;

  beforeAll(async () => {
    pg = await createMigratedDb();
  });

  afterAll(async () => {
    await pg.close();
  });

  it("ships every tenant-scoped AI persistence table", async () => {
    const tables = await tableNames(pg);
    expect(tables).toEqual(
      expect.arrayContaining([
        "conversations",
        "messages",
        "ai_capabilities",
        "ai_capability_versions",
        "workspace_ai_config",
        "workspace_ai_capability_overrides",
        "ai_runs",
        "ai_model_calls",
        "ai_tool_calls",
        "workspace_ai_access_policies",
      ]),
    );
  });
});
