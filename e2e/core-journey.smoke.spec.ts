// Smoke test for both configured and unconfigured environments.
//
// What it proves: the app boots, reports configuration status, signs the owner in without a
// sign-in page, and renders the key entry routes without making OpenAI requests.
import { test, expect } from "@playwright/test";

test.describe("core journey smoke (no session, no live AI)", () => {
  test("home signs the owner in automatically, or explains how to finish setup", async ({ page, request }) => {
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

  test("a link to the import page opens it without a sign-in step", async ({ page, request }) => {
    test.skip(!(await (await request.get("/api/health")).json()).supabase, "Needs the self-hosted backend");
    await page.goto("/import");
    await expect(page).toHaveURL(/\/import$/);
  });
});
