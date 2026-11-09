import { test, expect } from "@playwright/test";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { e2eStorageStatePath, gatedSkipReason, hasSupabaseEnv } from "./fixtures";

// Chat answering from the same net worth calculation as Home. Calls the real AI provider, so it costs money: run it only when you mean to.
const state = e2eStorageStatePath();
if (state) test.use({ storageState: state });
test.skip(!hasSupabaseEnv() || !state || !process.env.E2E_REAL_AI, process.env.E2E_REAL_AI ? gatedSkipReason() : "Set E2E_REAL_AI=1 to call the real AI provider");

test("chat quotes the total that Home shows", async ({ page }) => {
  test.setTimeout(180_000);
  const db = postgres(process.env.SUPABASE_DB_URL!, { max: 1, onnotice: () => {} });
  const [{ id: workspace }] = await db`select w.id from public.workspaces w join auth.users u on u.id=w.owner_id where u.email=${process.env.E2E_USER_EMAIL!}`;
  const [account] = await db`insert into public.accounts(workspace_id,name,currency_code,type) values(${workspace},${`Chat worth ${randomUUID().slice(0, 8)}`},'EUR','checking') returning id`;
  await db`insert into public.balance_snapshots(workspace_id,account_id,amount_minor,currency_code,as_of,provenance,boundary_kind) values(${workspace},${account.id},123456,'EUR',now(),'synthetic','date_only')`;
  const chatUsed = page.waitForResponse(response => new URL(response.url()).pathname === "/api/chat" && response.request().method() === "POST", { timeout: 120_000 });
  try {
    await page.goto("/");
    const headline = (await page.getByRole("region", { name: "Net worth" }).first().locator("p, span").filter({ hasText: /EUR|€/ }).first().textContent() ?? "").trim();
    const digits = headline.match(/[\d.,\s]*\d[.,]\d{2}/)?.[0].trim();
    expect(digits, `Home's headline: ${headline}`).toBeTruthy();
    await page.goto("/ai");
    await page.getByLabel(/ask about your finances/i).fill("What is my net worth today? Reply with the total exactly as your tool gives it.");
    await page.getByRole("button", { name: "Send" }).click();
    expect((await chatUsed).ok()).toBe(true);
    await expect(page.getByText(digits!).first()).toBeVisible({ timeout: 120_000 });
  } finally {
    await db`delete from public.balance_snapshots where account_id=${account.id}`;
    await db`delete from public.accounts where id=${account.id}`;
    await db.end();
  }
});
