import { expect, test, type Locator, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { deleteDisposableUser } from "./fixtures";

test.skip(!process.env.SUPABASE_DB_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL, "Requires disposable Supabase auth and database fixtures");

async function drag(page: Page, from: Locator, to: { x: number; y: number }) {
  await from.scrollIntoViewIfNeeded();
  const start = (await from.boundingBox())!;
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
  await page.mouse.down();
  await page.mouse.move(start.x + start.width / 2 + 10, start.y + start.height / 2 + 10, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 25 });
  await page.waitForTimeout(400);
  await page.mouse.up();
  await page.waitForTimeout(400);
}

test("a widget dropped in the empty space of a row goes there and stays after a reload", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 1300 });
  const db = postgres(process.env.SUPABASE_DB_URL!, { max: 1, onnotice: () => {} });
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = `qa-drag-${randomUUID()}@example.invalid`, password = randomBytes(24).toString("hex");
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { qa_test: "home-drag" } });
  expect(created.error).toBeNull();
  const user = created.data.user!.id;
  try {
    const [{ id: workspace }] = await db`select id from public.workspaces where owner_id=${user}`;
    await db`insert into public.dashboard_layouts(workspace_id,items,sizes) values(${workspace},${["recent", "accounts", "goals"]},${db.json({ recent: "L", accounts: "L", goals: "S" })})`;
    await page.goto("/login");
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL(url => url.pathname === "/");
    const widget = (name: string) => page.locator(`[data-widget="${name}"]`);
    await expect(widget("goals")).toBeVisible();
    const box = async (name: string) => (await widget(name).boundingBox())!;

    // Goals starts beside the second wide widget, with two free columns in the row above.
    expect(Math.abs((await box("goals")).y - (await box("accounts")).y)).toBeLessThan(2);
    const first = await box("recent"), grid = (await page.locator("[data-widget]").first().locator("..").boundingBox())!;
    await widget("goals").hover();
    await drag(page, page.getByRole("button", { name: /^Move Goals/ }), { x: grid.x + grid.width - 40, y: first.y + 60 });
    await expect.poll(async () => Math.abs((await box("goals")).y - (await box("recent")).y)).toBeLessThan(2);
    expect((await box("goals")).x).toBeGreaterThan((await box("recent")).x);

    await expect.poll(async () => (await db`select items from public.dashboard_layouts where workspace_id=${workspace}`)[0].items).toEqual(["recent", "goals", "accounts"]);
    await page.reload();
    await expect(widget("goals")).toBeVisible();
    expect(Math.abs((await box("goals")).y - (await box("recent")).y)).toBeLessThan(2);

    // Below the last widget still counts as a place to drop.
    await widget("recent").hover();
    const last = await box("accounts");
    await drag(page, page.getByRole("button", { name: /^Move Recent/ }), { x: last.x + 20, y: last.y + last.height + 200 });
    await expect.poll(async () => (await db`select items from public.dashboard_layouts where workspace_id=${workspace}`)[0].items).toEqual(["goals", "accounts", "recent"]);
  } finally {
    await deleteDisposableUser(db, user);
    await db.end();
  }
});
