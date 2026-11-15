import { test, expect } from "@playwright/test";
import { AUGUST_CSV,
  mockCompletedImport,
  mockInspectResponse, e2eStorageStatePath } from "./fixtures";

const signedIn = e2eStorageStatePath();
if (signedIn) test.use({ storageState: signedIn });

test.describe("deterministic import journey (mocked AI mapping, no credentials)", () => {
  test("requires a reviewed numeric convention and previews it before confirmation", async ({ page }) => {
    let selected: string | undefined;
    await page.route("**/api/imports", route => route.fulfill({ json: [] }));
    await page.route("**/api/imports/inspect", route => {
      const response = mockInspectResponse();
      selected = route.request().postData()?.includes("decimal-comma") ? "decimal-comma" : undefined;
      return route.fulfill({ json: { ...response, mapping: { ...response.mapping, numericConvention: selected } } });
    });
    await page.goto("/import");
    await expect(page.getByLabel("Financial statement files")).toBeEnabled();
    await page.getByLabel("Financial statement files").setInputFiles({ name: "synthetic.csv", mimeType: "text/csv", buffer: Buffer.from(AUGUST_CSV) });
    await expect(page.getByRole("button", { name: "Start import", exact: true })).toBeDisabled();
    await page.getByRole("combobox", { name: "Number format in your file" }).selectOption("decimal-comma");
    await expect(page.getByRole("button", { name: "Start import", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Preview correction" }).click();
    await expect(page.getByRole("button", { name: "Start import", exact: true })).toBeEnabled();
    expect(selected).toBe("decimal-comma");
  });
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
    let unstall!: () => void;
    const stalled = new Promise<void>(resolve => { unstall = resolve; });
    await page.route("**/api/imports", async route => {
      if (confirmed) { await stalled; await route.abort().catch(() => {}); }
      else await route.fulfill({ json: [] });
    });
    await page.route("**/api/imports/inspect", route => route.fulfill({ json: mockInspectResponse() }));
    await page.route("**/api/imports/confirm", async route => { confirmed = true; await route.fulfill({ json: { importId: "import-1", status: "queued" } }); });
    await page.goto("/import");
    await expect(page.getByText("No imports yet.")).toBeVisible();
    await expect(page.getByLabel("Financial statement files")).toBeEnabled();
    await page.getByLabel("Financial statement files").setInputFiles({ name: "august.csv", mimeType: "text/csv", buffer: Buffer.from(AUGUST_CSV) });
    await page.getByRole("button", { name: "Start import", exact: true }).click();
    await expect(page.locator("main").getByRole("alert").filter({ hasText: "Import history" })).toHaveText("Import history is unavailable. Try again.", { timeout: 15_000 });
    await expect(page.getByLabel("Financial statement files")).toBeEnabled();
    await expect(page.getByText("Working…", { exact: true })).toHaveCount(0);
    unstall();
  });
  test("upload → AI mapping preview → Correct → Continue → history → Cancel", async ({
    page,
  }) => {
    const openAiCalls: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("api.openai.com"))
        openAiCalls.push(request.url());
    });
    const unmocked: string[] = [];

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

    await expect(page.getByLabel("Financial statement files")).toBeEnabled();
    await page
      .getByLabel("Financial statement files")
      .setInputFiles({
        name: "august.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(AUGUST_CSV, "utf-8"),
      });

    await expect(page.getByText("august.csv (1 of 1)")).toBeVisible();
    await expect(page.getByText("Checking").first()).toBeVisible();
    await expect(
      page.getByText("2 rows", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Salary Acme")).toBeVisible();
    await expect(page.getByText("AMZN MKTP DE")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Start import", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Correct", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeVisible();
    expect(inspectCalls).toBe(1);

    await page
      .getByRole("button", { name: "Correct", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Preview correction" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Preview correction" })
      .click();
    await expect(page.getByText("Checking (corrected)", { exact: true })).toBeVisible();
    expect(inspectCalls).toBe(2);

    await page
      .getByRole("button", { name: "Start import", exact: true })
      .click();
    await expect(page.getByText("august.csv")).toBeVisible();
    await expect(
      page.getByText(
        "2 new · 0 already imported · 0 to review · 0 left out · 2 total",
      ),
    ).toBeVisible();
    await expect(
      page.getByText("august.csv (1 of 1)"),
    ).toHaveCount(0);
    expect(unmocked).toEqual([]);
    expect(openAiCalls).toEqual([]);
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
    await expect(page.getByRole("button", { name: "Start import", exact: true })).toHaveCount(0);
    await page.getByLabel("Amount signs").selectOption("signed");
    await page.getByRole("button", { name: "Preview correction" }).click();
    await expect(page.getByRole("button", { name: "Start import", exact: true })).toBeVisible();
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
    await expect(page.getByRole("button", { name: "Start import" })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Transaction ID", exact: true })).toHaveCount(0);
    await page.getByRole("radio", { name: "Two columns, money out and money in" }).check();
    await expect(page.getByRole("combobox", { name: "Amount", exact: true })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Money out", exact: true })).toHaveValue("");
    await page.getByRole("radio", { name: "One column, like -12.50 or 12.50" }).check();
    await expect(page.getByRole("combobox", { name: "Amount", exact: true })).toHaveValue("");
  });
});
