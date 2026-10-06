import { expect, it } from "vitest";
import { replayMigrations } from "./migration-replay.mjs";

it("identifies a missing upgrade constraint without treating unrecorded SQL as applied", async () => {
  const cause = Object.assign(new Error("missing constraint"), { code: "42704" });
  const tx = { unsafe: async () => { throw cause; } };
  await expect(replayMigrations(tx, [{ file: "202610040001_reimport_undone_files.sql", sql: "alter table public.imports drop constraint imports_workspace_hash_unique" }], "upgrade"))
    .rejects.toThrow(/upgrade.*202610040001.*42704.*migration history/);
});
