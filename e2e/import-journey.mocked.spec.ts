// Most useful deterministic Playwright test for Moneo's core journey
// (prompt.md §46) that can run WITHOUT Supabase credentials or OpenRouter.
//
// Why this slice: CSV/XLSX import with AI-proposed mapping → Preview →
// Continue / Correct / Cancel (§4–§5) is the highest-priority, highest-risk
// step of the whole loop. Everything downstream (Home, transactions, goals,
// forecasts, artifacts, re-import) depends on it, and the finance unit tests
// already cover minor-unit math but not the browser flow.
//
// Strategy: fully mock the AI/backend boundary with page.route fulfilments
// shaped exactly like the real routes, using synthetic fixtures from
// e2e/fixtures.ts. No request ever reaches Supabase or openrouter.ai — the
// test fails if one tries to. This exercises the real client component
// (app/import/page.tsx): file input → inspect → preview → Correct → Preview
// correction → Continue → import history → Cancel.
//
// Out of scope here (covered by the gated spec when creds exist): real auth,
// real row persistence, duplicate-detection against Postgres, background
// workflow polling.
import { test, expect } from "@playwright/test";
import {
  AUGUST_CSV,
  mockCompletedImport,
  mockInspectResponse,
} from "./fixtures";

test.describe("deterministic import journey (mocked AI mapping, no credentials)", () => {
  test("keeps the statement picker disabled until its upload handler hydrates", async ({ page }) => {
    let releaseScripts!: () => void;
    const scriptsReady = new Promise<void>(resolve => { releaseScripts = resolve; });
    await page.route("**/_next/static/**/*.js*", async route => { await scriptsReady; await route.continue(); });
    await page.route("**/api/imports", route => route.fulfill({ json: [] }));
    await page.route("**/api/imports/inspect", route => route.fulfill({ json: mockInspectResponse() }));
    try {
      await page.goto("/import", { waitUntil: "commit" });
      await expect(page.getByLabel("Financial statement files")).toBeDisabled();
    } finally { releaseScripts(); }
    await expect(page.getByLabel("Financial statement files")).toBeEnabled();
    await page.getByLabel("Financial statement files").setInputFiles({ name: "august.csv", mimeType: "text/csv", buffer: Buffer.from(AUGUST_CSV) });
    await expect(page.getByText("august.csv (1 of 1)")).toBeVisible();
  });
  test("a stalled history refresh cannot leave a confirmed import busy forever", async ({ page }) => {
    let confirmed = false;
    await page.route("**/api/imports", async route => {
      if (confirmed) { await new Promise(resolve => setTimeout(resolve, 20_000)); await route.abort(); }
      else await route.fulfill({ json: [] });
    });
    await page.route("**/api/imports/inspect", route => route.fulfill({ json: mockInspectResponse() }));
    await page.route("**/api/imports/confirm", async route => { confirmed = true; await route.fulfill({ json: { importId: "import-1", status: "queued" } }); });
    await page.goto("/import");
    await expect(page.getByText("No imports yet.")).toBeVisible();
    await expect(page.getByLabel("Financial statement files")).toBeEnabled();
    await page.getByLabel("Financial statement files").setInputFiles({ name: "august.csv", mimeType: "text/csv", buffer: Buffer.from(AUGUST_CSV) });
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.locator("main").getByRole("alert")).toHaveText("Import history is unavailable. Try again.", { timeout: 15_000 });
    await expect(page.getByLabel("Financial statement files")).toBeEnabled();
    await expect(page.getByText("Working…", { exact: true })).toHaveCount(0);
  });
  test("upload → AI mapping preview → Correct → Continue → history → Cancel", async ({
    page,
  }) => {
    const openRouterCalls: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("openrouter.ai"))
        openRouterCalls.push(request.url());
    });
    // Never let the test accidentally depend on a real backend: fail fast on
    // any unmocked imports API call.
    const unmocked: string[] = [];

    // GET /api/imports: empty before confirm, one completed row after.
    let confirmed = false;
    await page.route("**/api/imports", async (route) => {
      if (route.request().method() !== "GET") {
        unmocked.push(`${route.request().method()} ${route.request().url()}`);
        await route.abort();
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(confirmed ? [mockCompletedImport()] : []),
      });
    });

    // POST /api/imports/inspect: first call returns the canned "AI" mapping;
    // calls after the user edits (Preview correction) return a corrected
    // account name, proving the Correct round-trip reached the (mocked) API.
    let inspectCalls = 0;
    await page.route("**/api/imports/inspect", async (route) => {
      inspectCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          mockInspectResponse(
            inspectCalls === 1 ? "Checking" : "Checking (corrected)",
          ),
        ),
      });
    });

    // POST /api/imports/confirm: accept the file+mapping, flip history state.
    await page.route("**/api/imports/confirm", async (route) => {
      confirmed = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ importId: "import-1", status: "queued" }),
      });
    });

    await page.goto("/import");
    await expect(
      page.getByRole("heading", { name: "Import financial data" }),
    ).toBeVisible();
    await expect(page.getByText("No imports yet.")).toBeVisible();

    // 1. Upload — the file input inspects automatically.
    await expect(page.getByLabel("Financial statement files")).toBeEnabled();
    await page
      .getByLabel("Financial statement files")
      .setInputFiles({
        name: "august.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(AUGUST_CSV, "utf-8"),
      });

    // 2. AI-proposed interpretation is shown as an understandable preview,
    //    not raw column names.
    await expect(page.getByText("august.csv (1 of 1)")).toBeVisible();
    await expect(page.getByText("Account:")).toBeVisible();
    await expect(page.getByText("Checking").first()).toBeVisible();
    await expect(
      page.getByText("2 rows", { exact: false }),
    ).toBeVisible();
    await expect(page.getByText("Salary Acme")).toBeVisible();
    await expect(page.getByText("AMZN MKTP DE")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Continue", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Correct", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeVisible();
    expect(inspectCalls).toBe(1);

    // 3. Correct — open the manual mapping editor and re-preview.
    await page
      .getByRole("button", { name: "Correct", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Preview correction" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Preview correction" })
      .click();
    await expect(page.getByText("Checking (corrected)")).toBeVisible();
    expect(inspectCalls).toBe(2);

    // 4. Continue — confirm the import; history shows exact row counts and
    //    the preview section clears.
    await page
      .getByRole("button", { name: "Continue", exact: true })
      .click();
    await expect(page.getByText("august.csv")).toBeVisible();
    await expect(
      page.getByText(
        "2 new · 0 matched · 0 for review · 0 rejected · 2 total",
      ),
    ).toBeVisible();
    await expect(
      page.getByText("august.csv (1 of 1)"),
    ).toHaveCount(0);
    expect(unmocked).toEqual([]);
    expect(openRouterCalls).toEqual([]);
  });

  test("cancel discards the preview without importing", async ({ page }) => {
    await page.route("**/api/imports", async (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "[]",
      }),
    );
    await page.route("**/api/imports/inspect", async (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(mockInspectResponse()),
      }),
    );
    let confirmCalled = false;
    await page.route("**/api/imports/confirm", async (route) => {
      confirmCalled = true;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ importId: "import-1", status: "queued" }),
      });
    });

    await page.goto("/import");
    await expect(page.getByLabel("Financial statement files")).toBeEnabled();
    await page
      .getByLabel("Financial statement files")
      .setInputFiles({
        name: "august.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(AUGUST_CSV, "utf-8"),
      });
    await expect(page.getByText("august.csv (1 of 1)")).toBeVisible();

    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(
      page.getByText("august.csv (1 of 1)"),
    ).toHaveCount(0);
    await expect(page.getByText("No imports yet.")).toBeVisible();
    expect(confirmCalled).toBe(false);
  });

  test("asks for correction when AI proposes reversed amount signs", async ({ page }) => {
    await page.route("**/api/imports", route => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
    let calls = 0;
    await page.route("**/api/imports/inspect", route => {
      calls += 1;
      const proposal = mockInspectResponse();
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(calls === 1 ? { ...proposal, mapping: { ...proposal.mapping, amountSign: "outflow-positive" } } : proposal),
      });
    });
    await page.goto("/import");
    await expect(page.getByLabel("Financial statement files")).toBeEnabled();
    await page.getByLabel("Financial statement files").setInputFiles({
      name: "august.csv", mimeType: "text/csv", buffer: Buffer.from(AUGUST_CSV, "utf-8"),
    });
    await expect(page.getByRole("button", { name: "Preview correction" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toHaveCount(0);
    await page.getByLabel("Amount signs").selectOption("signed");
    await page.getByRole("button", { name: "Preview correction" }).click();
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeVisible();
  });

  test("selects matching headers when automatic interpretation fails", async ({ page }) => {
    await page.route("**/api/imports", route => route.fulfill({ status: 200, contentType: "application/json", body: "[]" }));
    await page.route("**/api/imports/inspect", route => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        headers: ["Type", "Product", "Started Date", "Completed Date", "Description", "Amount"],
        sample: [{ Type: "Transfer", Product: "Savings", "Started Date": "2025-11-10 17:04:58", "Completed Date": "2025-11-10 17:04:58", Description: "Transfer", Amount: "100.00" }],
        mapping: null,
        preview: null,
        aiError: "No object generated",
      }),
    }));
    await page.goto("/import");
    await expect(page.getByLabel("Financial statement files")).toBeEnabled();
    await page.getByLabel("Financial statement files").setInputFiles({
      name: "statement.csv", mimeType: "text/csv", buffer: Buffer.from("Type,Product,Started Date,Completed Date,Description,Amount\nTransfer,Savings,2025-11-10 17:04:58,2025-11-10 17:04:58,Transfer,100.00"),
    });
    await expect(page.getByRole("combobox", { name: "Date", exact: true })).toHaveValue("Completed Date");
    await expect(page.getByRole("combobox", { name: "Description", exact: true })).toHaveValue("Description");
    await expect(page.getByRole("combobox", { name: "Amount", exact: true })).toHaveValue("Amount");
    await expect(page.getByRole("button", { name: "Continue" })).toHaveCount(0);
  });
});
