import { test, expect } from "@playwright/test";

const ROUTES = ["/home", "/money", "/plan", "/ai", "/settings"] as const;

for (const route of ROUTES) {
  test(`route ${route} direct-loads with shell mounts`, async ({ page }) => {
    await page.goto(route);
    await expect(page.locator("nav[aria-label='Primary']")).toBeVisible();
    await expect(page.locator("#job-indicator-mount")).toBeVisible();
    await expect(page.locator("#notification-mount")).toBeAttached();
    await expect(page.locator("#ai-panel-mount")).toBeVisible();
  });
}

test("keyboard navigation reaches all primary routes", async ({ page }) => {
  await page.goto("/home");
  for (const route of ROUTES) {
    const link = page.locator(`nav[aria-label='Primary'] a[href='${route}']`);
    await link.focus();
    await expect(link).toBeFocused();
    await link.press("Enter");
    await expect(page).toHaveURL(route);
  }
});

test("health and version endpoints respond without secrets", async ({ request }) => {
  const health = await request.get("/api/v1/health");
  expect(health.ok()).toBeTruthy();

  const version = await request.get("/api/v1/version");
  expect(version.ok()).toBeTruthy();
  const body = await version.json();
  expect(body).toMatchObject({
    gitSha: expect.any(String),
    releaseId: expect.any(String),
    schemaVersion: expect.any(String),
    environment: expect.any(String),
  });
  const serialized = JSON.stringify(body).toLowerCase();
  expect(serialized).not.toContain("password");
  expect(serialized).not.toContain("secret");
  expect(serialized).not.toContain("postgres://");
});
