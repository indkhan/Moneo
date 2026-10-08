import { expect, test } from "@playwright/test";
import { hasSupabaseEnv } from "./fixtures";

test("sign-in shows pending feedback and allows retry after a rejected request without sending email", async ({ page }) => {
  test.skip(!hasSupabaseEnv(), "Configured Supabase client is needed for the mocked OTP request");
  let requests = 0;
  let release!: () => void;
  const firstResponse = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/auth/v1/otp*", async route => {
    requests += 1;
    if (requests === 1) {
      await firstResponse;
      await route.fulfill({ status: 429, json: { msg: "Synthetic sign-in request rejected", error_code: "over_email_send_rate_limit" } });
    } else await route.fulfill({ status: 200, json: {} });
  });
  try {
    await page.goto("/login");
    await page.getByLabel("Email", { exact: true }).fill("qa-login@example.invalid");
    await page.getByRole("button", { name: "Send sign-in link", exact: true }).click();
    await expect.poll(() => requests).toBe(1);
    await expect(page.getByRole("button", { name: "Sending…", exact: true })).toBeDisabled();
    release();
    await expect(page.getByRole("status")).toContainText("Synthetic sign-in request rejected");
    const retry = page.getByRole("button", { name: "Send sign-in link", exact: true });
    await expect(retry).toBeEnabled();
    await retry.click();
    await expect(page.getByRole("status")).toContainText("Check your email for the sign-in link.");
    expect(requests).toBe(2);
  } finally { release(); }
});
