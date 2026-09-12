import { afterEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createMigratedDb } from "./pglite-test-db.js";

describe("createMigratedDb", () => {
  let db: PGlite | undefined;

  afterEach(async () => {
    await db?.close();
  });

  it("applies the latest shipped migration when no historical prefix is requested", async () => {
    db = await createMigratedDb();
    const result = await db.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'accounts' AND column_name = 'version'",
    );
    expect(result.rows).toEqual([{ column_name: "version" }]);
  });
});
