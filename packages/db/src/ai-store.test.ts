import { afterAll, beforeAll, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { createMigratedDb } from "./pglite-test-db.js";
import { createAiStore } from "./ai-store.js";

let pg: PGlite;
const a = "00000000-0000-4000-8000-000000000001",
  b = "00000000-0000-4000-8000-000000000002";
beforeAll(async () => {
  pg = await createMigratedDb();
  await pg.query("INSERT INTO workspaces(id,name) VALUES ($1,'A'),($2,'B')", [a, b]);
});
afterAll(async () => {
  await pg.close();
});
it("persists conversation messages and never resolves a foreign conversation", async () => {
  const store = createAiStore(async (_wid, fn) => fn(drizzle(pg)));
  const thread = await store.createConversation(a, "Synthetic question");
  await store.addMessage(a, thread.id, "user", { text: "Hello" }, 1);
  expect((await store.getConversation(a, thread.id))?.messages[0]?.content).toBe("Hello");
  expect(await store.getConversation(b, thread.id)).toBeNull();
  await expect(store.addMessage(b, thread.id, "user", { text: "intrusion" }, 1)).rejects.toThrow();
});
it("excludes account data before loading context and invalidates old history on policy changes", async () => {
  const store = createAiStore(async (_wid, fn) => fn(drizzle(pg)));
  const account = "00000000-0000-4000-8000-000000000003";
  await pg.query(
    "INSERT INTO accounts(id,workspace_id,name,currency_code) VALUES($1,$2,'SECRET SENTINEL','EUR')",
    [account, a],
  );
  const thread = await store.createConversation(a, "Policy test");
  await store.addMessage(a, thread.id, "assistant", { text: "SECRET SENTINEL" }, 1);
  await store.updateSettings(a, { excludedAccountIds: [account] });
  expect(JSON.stringify(await store.source(a))).not.toContain("SECRET SENTINEL");
  expect(await store.history(a, thread.id)).toEqual([]);
  await expect(store.updateSettings(b, { excludedAccountIds: [account] })).rejects.toThrow();
});

it("does not publish stale evidence after an AI policy change", async () => {
  const store = createAiStore(async (_wid, fn) => fn(drizzle(pg)));
  const thread = await store.createConversation(a, "Evidence policy test");
  const version = (await store.settings(a)).aiPolicyVersion;
  const runId = await store.startRun(a, thread.id, version, {});
  const evidenceId = await store.recordTool(
    a,
    runId,
    "accounts.list",
    {},
    { result: { accounts: [] } },
  );

  expect(await store.evidence(a, evidenceId)).toMatchObject({ toolName: "accounts.list" });
  await store.updateSettings(a, { expectedVersion: version });
  expect(await store.evidence(a, evidenceId)).toBeNull();
});
