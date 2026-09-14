import { test, expect } from "@playwright/test";
test("a failed chat request can be retried with the original message", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/v1/ai/conversations", (route) =>
    route.fulfill({ json: { conversations: [] } }),
  );
  await page.route("**/api/v1/ai/chat", async (route) => {
    calls++;
    await route.fulfill(
      calls === 1
        ? { status: 503, json: { message: "Unavailable" } }
        : {
            contentType: "application/x-ndjson",
            body:
              JSON.stringify({ type: "text", text: "Recovered answer" }) +
              "\n" +
              JSON.stringify({ type: "done", runId: "r1" }),
          },
    );
  });
  await page.goto("/ai");
  const main = page.locator("main");
  await main.getByLabel("Ask about your finances").fill("August spending?");
  await main.getByRole("button", { name: "Send", exact: true }).click();
  await expect(main.getByRole("alert")).toBeVisible();
  await main.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(main.getByText("Recovered answer", { exact: true })).toBeVisible();
  expect(calls).toBe(2);
});
const conversationId = "00000000-0000-4000-8000-000000000031",
  runId = "00000000-0000-4000-8000-000000000032",
  evidenceId = "00000000-0000-4000-8000-000000000033";
test("chat streams evidence and shares its active conversation with the panel across navigation", async ({
  page,
}) => {
  const requests: Array<Record<string, unknown>> = [];
  await page.route("**/api/v1/ai/conversations", (route) =>
    route.fulfill({ json: { conversations: [] } }),
  );
  await page.route("**/api/v1/ai/chat", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      contentType: "application/x-ndjson",
      body: [
        { type: "conversation", conversationId },
        { type: "tool", name: "analytics.cashflow", status: "succeeded" },
        { type: "text", text: "You spent 12.34 EUR in August." },
        {
          type: "evidence",
          evidence: {
            id: evidenceId,
            label: "August cashflow",
            href: `/ai/evidence/${evidenceId}`,
          },
        },
        { type: "done", runId },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n"),
    });
  });
  await page.goto("/ai");
  const main = page.locator("main"),
    panel = page.locator("#ai-panel-mount");
  await main.getByLabel("Ask about your finances").fill("August spending?");
  await main.getByRole("button", { name: "Send", exact: true }).click();
  await expect(main.getByText("You spent 12.34 EUR in August.", { exact: true })).toBeVisible();
  await expect(panel.getByText("You spent 12.34 EUR in August.", { exact: true })).toBeVisible();
  await expect(main.getByRole("link", { name: "Evidence · August cashflow" })).toHaveAttribute(
    "href",
    `/ai/evidence/${evidenceId}`,
  );
  await page.screenshot({ path: "test-results/chat-workspace.png", fullPage: true });
  await page.locator("nav[aria-label='Primary'] a[href='/money']").click();
  await expect(panel.getByText("You spent 12.34 EUR in August.", { exact: true })).toBeVisible();
  await panel.getByRole("button", { name: /Remove .* context/ }).click();
  await panel.getByLabel("Ask about your finances").fill("What about income?");
  await panel.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]?.conversationId).toBe(conversationId);
  expect(requests[1]?.context).toBeUndefined();
});
test("command search exposes the equivalent typed filters and keeps focus inside its dialog", async ({
  page,
}) => {
  await page.route("**/api/v1/transactions/search?**", (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.goto("/home");
  await page.getByRole("button", { name: "Open command search" }).click();
  const dialog = page.getByRole("dialog", { name: "Command search" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Search navigation and commands").fill("show restaurants last month");
  await expect(dialog.getByText(/Transaction filters:.*dateFrom:.*q: restaurants/)).toBeVisible();
  await expect(
    dialog.getByRole("link", { name: "Apply these transaction filters" }),
  ).toHaveAttribute("href", /q=restaurants/);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Open command search" })).toBeFocused();
});
