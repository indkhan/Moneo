// Smoke test for both configured and unconfigured environments.
//
// What it proves: the app boots, reports configuration status, and renders
// the key entry routes without making OpenAI requests.
import { test, expect } from "@playwright/test";

test.describe("core journey smoke (no session, no live AI)", () => {
  test("home shows setup guidance or redirects unauthenticated users", async ({
    page, request,
  }) => {
    const openAiCalls: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("api.openai.com"))
        openAiCalls.push(request.url());
    });

    const health = await (await request.get("/api/health")).json();
    await page.goto("/");
    if (health.supabase) await expect(page).toHaveURL(/\/login$/);
    else await expect(page.getByText(/to start Moneo\./)).toBeVisible();
    expect(openAiCalls).toEqual([]);
  });

  test("health endpoint reports backend configuration", async ({
    request,
  }) => {
    const response = await request.get("/api/health");
    expect(response.ok()).toBe(true);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.supabase).toBe(Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY));
    expect(body.openai).toBe(Boolean(process.env.OPENAI_API_KEY));
  });

  test("login page renders email and password form", async ({ page }) => {
    await page.goto("/login");
    await expect(
      page.getByRole("heading", { name: "Sign in to Moneo" }),
    ).toBeVisible();
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeVisible();
  });

  test("a signed-out link to the import page goes to login and remembers it", async ({ page }) => {
    await page.goto("/import");
    await expect(page).toHaveURL(/login[?]next=%2Fimport$/);
  });
});
