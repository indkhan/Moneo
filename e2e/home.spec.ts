import { test, expect } from "@playwright/test";

test("home explains missing Supabase setup", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Configure Supabase in .env to start Moneo.")).toBeVisible();
});
