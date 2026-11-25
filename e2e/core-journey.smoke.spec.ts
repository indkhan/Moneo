import { test, expect, type BrowserContext } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { randomBytes, randomUUID } from "node:crypto";
import postgres from "postgres";
import { deleteDisposableUser, hasSupabaseEnv } from "./fixtures";

async function withRevokedSession(context: BrowserContext, run: () => Promise<void>) {
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
    expect((await auth.auth.signOut()).error).toBeNull();
    await context.addCookies(signedIn);
    await run();
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
      if (hasSupabaseEnv()) await withRevokedSession(context, expectSetupHelp);
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
  });
});
