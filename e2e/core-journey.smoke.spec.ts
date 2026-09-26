// Credential-free smoke test. Runs with blank .env (current repo state).
//
// What it proves: the app boots, reports missing Supabase honestly instead of
// crashing, exposes /api/health with supabase:false/openrouter:false, and the
// key entry routes render their empty/disabled states. It makes NO network
// calls to OpenRouter and requires NO Supabase credentials.
import { test, expect } from "@playwright/test";

test.describe("core journey smoke (no credentials, no live AI)", () => {
  test("home explains missing Supabase setup instead of crashing", async ({
    page,
  }) => {
    const openRouterCalls: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("openrouter.ai"))
        openRouterCalls.push(request.url());
    });

    await page.goto("/");
    await expect(
      page.getByText("Configure Supabase in .env to start Moneo."),
    ).toBeVisible();
    expect(openRouterCalls).toEqual([]);
  });

  test("health endpoint reports unconfigured backends honestly", async ({
    request,
  }) => {
    const response = await request.get("/api/health");
    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.ok).toBe(true);
    // Blank .env => both backends honestly reported as absent.
    expect(body.supabase).toBe(false);
    expect(body.openrouter).toBe(false);
  });

  test("login page renders OTP form", async ({ page }) => {
    await page.goto("/login");
    await expect(
      page.getByRole("heading", { name: "Sign in to Moneo" }),
    ).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Send sign-in link" }),
    ).toBeVisible();
  });

  test("import page renders picker and empty history without credentials", async ({
    page,
  }) => {
    await page.goto("/import");
    await expect(
      page.getByRole("heading", { name: "Import financial data" }),
    ).toBeVisible();
    await expect(
      page.getByLabel("Financial statement files"),
    ).toBeVisible();
    // Without a session GET /api/imports is 401; the page keeps an empty
    // history ("No imports yet.") rather than showing fake rows.
    await expect(page.getByText("No imports yet.")).toBeVisible();
  });
});
