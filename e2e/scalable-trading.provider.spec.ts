// Scalable in chat against the local stand-in (e2e/mocks/scalable-mcp.mjs), with the real AI model, so it costs a
// little: run it only when you mean to. Start the app with SCALABLE_MCP_ORIGIN=http://127.0.0.1:3043 and run with the
// same variable set. Proves an order is sent only by tapping its card, exactly once, and that read-only access says so.
import { spawn, type ChildProcess } from "node:child_process";
import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { encryptToken } from "../lib/bank/token-crypto";
import { e2eStorageStatePath, gatedSkipReason, hasSupabaseEnv } from "./fixtures";

const state = e2eStorageStatePath();
if (state) test.use({ storageState: state });
const MOCK = process.env.SCALABLE_MCP_ORIGIN;
test.skip(!hasSupabaseEnv() || !state || !MOCK?.startsWith("http://127.0.0.1"), MOCK ? gatedSkipReason() : "Set SCALABLE_MCP_ORIGIN=http://127.0.0.1:3043 for the app and this run");
test.describe.configure({ mode: "serial" });

let mock: ChildProcess, db: postgres.Sql, connection: string;
test.beforeAll(async () => {
  mock = spawn(process.execPath, ["e2e/mocks/scalable-mcp.mjs"], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise<void>(resolve => mock.stdout!.once("data", () => resolve()));
  db = postgres(process.env.SUPABASE_DB_URL!, { max: 1, onnotice: () => {} });
  const [{ id: workspace }] = await db`select w.id from public.workspaces w join auth.users u on u.id=w.owner_id where u.email=${process.env.E2E_USER_EMAIL!}`;
  connection = crypto.randomUUID();
  const tokens = encryptToken(JSON.stringify({ accessToken: "mock-access", refreshToken: "mock-refresh", expiresAt: Date.now() + 3_600_000 }), connection);
  await db`insert into public.scalable_connections (id, workspace_id, client_id, redirect_uri, status, tokens_encrypted)
    values (${connection}, ${workspace}, 'mock', 'http://localhost:3100/api/scalable/callback', 'active', ${tokens})`;
});
test.afterAll(async () => {
  await db`delete from public.agent_proposals where kind in ('scalable_order','scalable_cancel') and workspace_id = (select workspace_id from public.scalable_connections where id = ${connection})`;
  // The synced positions are the QA workspace's own wealth items; reset with scripts/e2e-auth.mjs --reset clears them.
  await db`delete from public.scalable_connections where id = ${connection}`;
  await db.end();
  mock.kill();
});
const calls = async () => (await (await fetch(`${MOCK}/calls`)).json()) as { name: string; args: Record<string, unknown> }[];
const mode = (access: "full" | "read") => fetch(`${MOCK}/mode`, { method: "POST", body: JSON.stringify({ access }) });

async function ask(page: import("@playwright/test").Page, question: string) {
  await page.goto("/ai?conversation=new");
  await page.locator("main").getByLabel("Ask about your finances").fill(question);
  await page.locator("main").getByRole("button", { name: "Send", exact: true }).click();
}

test("the Wealth page shows the synced portfolio", async ({ page }) => {
  test.setTimeout(60_000);
  await mode("full");
  const synced = await page.request.post(`/api/scalable/connections/${connection}/sync`);
  expect(synced.status()).toBe(200);
  await page.goto("/money/wealth");
  const panel = page.getByRole("region", { name: "Scalable Capital" });
  await expect(panel).toContainText("Test Tech ETF (Acc)");
  await expect(panel).toContainText("today");
  await expect(panel).toContainText("Recent activity");
  await panel.scrollIntoViewIfNeeded();
});

test("a buy is previewed on a card and sent only when the card is tapped, once", async ({ page }) => {
  test.setTimeout(150_000);
  await mode("full");
  await ask(page, "Buy 2 shares of Test Tech ETF at market on Scalable");
  const card = page.getByRole("region", { name: "Buy card" });
  await expect(card).toBeVisible({ timeout: 90_000 });
  await expect(card.getByRole("timer")).toContainText("Valid for");
  await expect(card).toContainText("Test Tech ETF (Acc)");
  // Previewed, never submitted, before the tap.
  expect((await calls()).map(call => call.name)).toContain("preview_buy_order");
  expect((await calls()).some(call => call.name.startsWith("submit_"))).toBe(false);
  await card.getByText("Scalable's full review").click();
  await card.getByRole("button", { name: /^Buy:/ }).click();
  await expect(card.getByRole("status")).toContainText("Order sent to Scalable", { timeout: 30_000 });
  const submits = (await calls()).filter(call => call.name === "submit_buy_order");
  expect(submits).toHaveLength(1);
  expect(submits[0].args).toMatchObject({ acknowledgementIds: [], submission: { executionIntent: { side: "buy", isin: "DE000A0TEST1", numberOfShares: "2" } } });
});

test("a read-only connection is told it can't trade", async ({ page }) => {
  test.setTimeout(120_000);
  await mode("read");
  await ask(page, "Sell 1 share of Test Tech ETF on Scalable");
  await expect(page.locator("main")).toContainText(/only allows read access/i, { timeout: 90_000 });
  await expect(page.getByRole("region", { name: "Sell card" })).toHaveCount(0);
  expect((await calls()).some(call => /^(preview|submit)_/.test(call.name))).toBe(false);
});
