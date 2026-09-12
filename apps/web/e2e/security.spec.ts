import { expect, test } from "@playwright/test";

/**
 * Issue 1.6 acceptance probes (run against the hardened middleware):
 * - security headers present on every response, incl. API 403s
 * - cross-origin POST rejected, same-origin POST with token passes the gate
 * - CSRF cookie issued host-only; session cookie flags verified on callback
 *   paths is covered by unit tests (no Auth0 tenant here)
 */
test("hardening headers ship on pages and api responses", async ({ request }) => {
  const page = await request.get("/home");
  expect(page.ok()).toBeTruthy();
  expect(page.headers()["content-security-policy"]).toContain("default-src 'self'");
  expect(page.headers()["x-content-type-options"]).toBe("nosniff");
  expect(page.headers()["referrer-policy"]).toBe("same-origin");
  expect(page.headers()["permissions-policy"]).toContain("camera=()");

  const denied = await request.post("/api/v1/health");
  expect(denied.status()).toBe(403);
  expect(denied.headers()["content-security-policy"]).toContain("default-src 'self'");
});

test("cross-origin write rejected; token-bearing same-origin write passes the gate", async ({
  request,
}) => {
  const evil = await request.post("/api/v1/health", { headers: { origin: "https://evil.com" } });
  expect(evil.status()).toBe(403);
  expect(await evil.json()).toMatchObject({ error: "forbidden" });

  const get = await request.get("/home");
  const csrfCookies = get.headersArray().filter((h) => h.name.toLowerCase() === "set-cookie");
  const csrfCookie = csrfCookies.map((h) => h.value).join("; ");
  const token = csrfCookie.match(/__Host-moneo_csrf=([^;]+)/)?.[1];
  expect(token).toBeTruthy();
  expect(csrfCookie).not.toMatch(/Domain=/i);

  const ok = await request.post("/api/v1/health", {
    headers: { origin: "http://localhost:3000", "x-csrf-token": token as string },
  });
  // /api/v1/health only implements GET, so 405 proves the request passed the
  // CSRF gate and reached routing (a gate failure would be 403).
  expect(ok.status()).not.toBe(403);
});

test("app hydrates and navigates with script-src self (no CSP-broken boot)", async ({ page }) => {
  const violations: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) {
      violations.push(message.text());
    }
  });
  await page.goto("/home");
  await expect(page.locator("nav[aria-label='Primary']")).toBeVisible();
  await page.locator("nav[aria-label='Primary'] a[href='/settings']").click();
  await expect(page).toHaveURL("/settings");
  expect(violations).toEqual([]);
});
