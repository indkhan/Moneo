// Smoke test for both configured and unconfigured environments.
//
// What it proves: the app boots, reports configuration status, opens signed in without a
// sign-in page, and renders the key entry routes without making OpenAI requests.
import { test, expect } from "@playwright/test";
import { hasSupabaseEnv } from "./fixtures";

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
    // Keys can be saved in the app, so only the shape is fixed here.
    expect(typeof body.openai).toBe("boolean");
  });

  test("the setup page explains how to finish setup", async ({ page }) => {
    await page.goto("/setup");
    await expect(page.getByRole("heading", { name: "Moneo could not sign you in" })).toBeVisible();
    await expect(page.getByText("npm run setup")).toBeVisible();
  });

  // Phones install Moneo as an app. Its service worker must never keep financial pages or answers
  // on the device: offline, the owner sees only the stand-in page.
  test("installs as an app and, with the computer unreachable, shows only the offline page", async ({ page, context }) => {
    const manifest = await (await page.request.get("/manifest.webmanifest")).json();
    expect(manifest).toMatchObject({ id: "/", scope: "/", start_url: "/", display: "standalone" });
    expect(manifest.icons.map((icon: { purpose?: string }) => icon.purpose)).toContain("maskable");

    await page.goto("/");
    // Registered by hand: the app registers its worker in production builds only, the worker file is the same.
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
