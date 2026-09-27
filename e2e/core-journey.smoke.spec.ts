// Smoke test for both configured and unconfigured environments.
//
// What it proves: the app boots, reports configuration status, and renders
// the key entry routes without making OpenRouter requests.
import { test, expect } from "@playwright/test";

test.describe("core journey smoke (no session, no live AI)", () => {
  test("home shows setup guidance or redirects unauthenticated users", async ({
    page, request,
  }) => {
    const openRouterCalls: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("openrouter.ai"))
        openRouterCalls.push(request.url());
    });

    const health = await (await request.get("/api/health")).json();
    await page.goto("/");
    if (health.supabase) await expect(page).toHaveURL(/\/login$/);
    else await expect(page.getByText("Configure Supabase in .env to start Moneo.")).toBeVisible();
    expect(openRouterCalls).toEqual([]);
  });

  test("health endpoint reports backend configuration", async ({
    request,
  }) => {
    const response = await request.get("/api/health");
    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.supabase).toBe(Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY));
    expect(body.openrouter).toBe(Boolean(process.env.OPENROUTER_API_KEY));
    expect(body.model).toMatch(/:free$/);
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
