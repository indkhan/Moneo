import { describe, expect, it } from "vitest";
import { runMigrations } from "./migrate-lib.js";

describe("runMigrations", () => {
  it.skipIf(!process.env.DATABASE_MIGRATION_URL)("applies the checked-in migrations on Windows", async () => {
    await expect(runMigrations()).resolves.toBeUndefined();
  });
});
