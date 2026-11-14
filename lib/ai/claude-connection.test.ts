import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { claudeAccount, forgetClaudeAccount, setClaudeConnected, type ClaudeAccount } from "./claude";

let dir: string;
afterEach(async () => {
  forgetClaudeAccount();
  vi.unstubAllEnvs();
  if (dir) await rm(dir, { recursive: true, force: true });
});

// Regression: a fresh Moneo install inherited the computer's Claude Code login without consent.
it("uses an existing Claude login only after connection, and stops using it after disconnection", async () => {
  dir = await mkdtemp(path.join(tmpdir(), "moneo-claude-consent-"));
  vi.stubEnv("MONEO_DATA_DIR", dir);
  const account: ClaudeAccount = { installed: true, signedIn: true, email: "owner@example.com", plan: "max", problem: null };
  (globalThis as typeof globalThis & { moneoClaudeAccount?: { at: number; value: Promise<ClaudeAccount> } }).moneoClaudeAccount = { at: Date.now(), value: Promise.resolve(account) };
  expect(await claudeAccount()).toMatchObject({ signedIn: false, email: null });
  await setClaudeConnected(true);
  expect(await claudeAccount()).toEqual(account);
  await setClaudeConnected(false);
  expect(await claudeAccount()).toMatchObject({ signedIn: false, email: null });
});
