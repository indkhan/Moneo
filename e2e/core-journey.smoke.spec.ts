import { test, expect, type BrowserContext } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { randomBytes, randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import { deleteDisposableUser, hasSupabaseEnv } from "./fixtures";

async function withDisposableUser(context: BrowserContext, { revoked }: { revoked: boolean }, run: (db: Sql, workspace: string) => Promise<void>) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = `qa-${randomUUID()}@example.invalid`, password = randomBytes(24).toString("hex");
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { qa_test: "setup-page" } });
  expect(created.error).toBeNull();
  const db = postgres(process.env.SUPABASE_DB_URL!, { max: 1 });
  try {
    const jar = new Map<string, string>();
    const auth = createServerClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { cookies: { getAll: () => [...jar].map(([name, value]) => ({ name, value })), setAll: values => values.forEach(({ name, value }) => jar.set(name, value)) } });
    expect((await auth.auth.signInWithPassword({ email, password })).error).toBeNull();
    const signedIn = [...jar].map(([name, value]) => ({ name, value, domain: "localhost", path: "/", sameSite: "Lax" as const }));
    if (revoked) expect((await auth.auth.signOut()).error).toBeNull();
    await context.addCookies(signedIn);
    const [{ id: workspace }] = await db`select id from public.workspaces where owner_id=${created.data.user!.id}`;
    await run(db, workspace);
  } finally {
    await deleteDisposableUser(db, created.data.user!.id);
    await db.end();
  }
}

test.describe("core journey smoke (no session, no live AI)", () => {
  test("home opens signed in, or explains how to finish setup", async ({ page, request }) => {
    const openAiCalls: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("api.openai.com")) openAiCalls.push(request.url());
    });

    const health = await (await request.get("/api/health")).json();
    await page.goto("/");
    if (health.supabase) {
      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByRole("navigation").first()).toBeVisible();
    } else await expect(page.getByText(/npm run setup/)).toBeVisible();
    expect(openAiCalls).toEqual([]);
  });

  test("health endpoint reports backend configuration", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.supabase).toBe(Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY));
    expect(typeof body.openai).toBe("boolean");
  });

  test.describe("signed out", () => {
    test.use({ storageState: { cookies: [], origins: [] } });
    test.skip(hasSupabaseEnv() && (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.SUPABASE_DB_URL), "Needs the service key to create a disposable user");
    test("a sign-in the backend no longer accepts explains how to finish setup", async ({ page, context }) => {
      const expectSetupHelp = async () => {
        await page.goto("/");
        await expect(page).toHaveURL(/\/setup$/);
        await expect(page.getByRole("heading", { name: "Moneo could not sign you in" })).toBeVisible();
        await expect(page.getByText("npm run setup")).toBeVisible();
      };
      if (hasSupabaseEnv()) await withDisposableUser(context, { revoked: true }, expectSetupHelp);
      else await expectSetupHelp();
    });
  });

  test("installs as an app and, with the computer unreachable, shows only the offline page", async ({ page, context }) => {
    const manifest = await (await page.request.get("/manifest.webmanifest")).json();
    expect(manifest).toMatchObject({ id: "/", scope: "/", start_url: "/", display: "standalone" });
    expect(manifest.icons.map((icon: { purpose?: string }) => icon.purpose)).toContain("maskable");

    await page.goto("/");
    await page.evaluate(async () => { await navigator.serviceWorker.register("/sw.js", { scope: "/" }); await navigator.serviceWorker.ready; });
    await page.reload();
    expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    await page.evaluate(() => fetch("/api/health"));
    const stored = () => page.evaluate(async () => {
      const urls: string[] = [];
      for (const name of await caches.keys()) for (const entry of await (await caches.open(name)).keys()) urls.push(new URL(entry.url).pathname);
      return urls;
    });
    expect(await stored()).toEqual(["/offline.html"]);

    await context.setOffline(true);
    await page.goto("/money/accounts");
    await expect(page.getByRole("navigation")).toHaveCount(0);
    await expect(page.locator("body > main")).toBeVisible();
    expect(await page.evaluate(() => fetch("/api/health").then(() => "served", () => "failed"))).toBe("failed");
    expect(await stored()).toEqual(["/offline.html"]);
    await context.setOffline(false);
  });

  test.describe("with the self-hosted backend", () => {
    test.skip(!hasSupabaseEnv(), "Needs the self-hosted backend");
    test("a link to the import page opens it without a sign-in step", async ({ page }) => {
      await page.goto("/import");
      await expect(page).toHaveURL(/\/import$/);
    });

    test.describe("a fresh workspace", () => {
      test.use({ storageState: { cookies: [], origins: [] } });
      test.skip(!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.SUPABASE_DB_URL, "Needs the service key to create a disposable user");
      test("Home starts with the first steps: AI can be skipped, money has two routes, and the agent team waits for transactions", async ({ page, context }) => {
        await withDisposableUser(context, { revoked: false }, async (db, workspace) => {
          const aiOn = (await (await page.request.get("/api/ai/status")).json()).ai as boolean;
          await page.goto("/");
          const steps = page.getByRole("region", { name: "Get started" });
          await expect(steps).toBeVisible();
          const [first] = await page.locator("main section").evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-labelledby")));
          expect(first).toBe("first-steps");
          await expect(page.getByRole("button", { name: "Customize", exact: true })).toHaveCount(0);
          await expect(page.getByRole("button", { name: "Add widget" })).toHaveCount(0);
          await expect(page.getByRole("link", { name: /^Call Moneo/ })).toBeVisible();
          if (!aiOn) {
            await steps.getByRole("button", { name: "Skip for now" }).click();
            await expect(steps.getByRole("heading", { name: "AI skipped" })).toBeVisible();
            await page.reload();
            await expect(steps.getByRole("heading", { name: "AI skipped" })).toBeVisible();
          } else await expect(steps.getByRole("heading", { name: "AI is on" })).toBeVisible();
          await expect(steps.getByRole("link", { name: "Import a statement" })).toHaveAttribute("href", "/import");
          await expect(steps.getByRole("link", { name: "Connect a bank" })).toBeVisible();
          await expect(steps.getByText("Needs a free Enable Banking account")).toBeVisible();
          await expect(steps.getByRole("heading", { name: "Run the agent team" })).toHaveCount(0);

          const [account] = await db`insert into public.accounts(workspace_id,name,type,currency_code) values(${workspace},'First checking','checking','EUR') returning id`;
          await db`insert into public.transactions(workspace_id,account_id,posted_on,description,amount_minor,currency_code) values(${workspace},${account.id},'2026-10-01','First coffee',-350,'EUR')`;
          await page.reload();
          await expect(page.getByRole("button", { name: "Customize", exact: true })).toBeVisible();
          if (aiOn) {
            await expect(steps.getByRole("heading", { name: "Money added" })).toBeVisible();
            await expect(steps.getByRole("button", { name: "Run agent team" })).toBeVisible();
          } else await expect(steps).toHaveCount(0);
        });
      });
    });
  });
});
