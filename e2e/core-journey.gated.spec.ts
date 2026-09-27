// Partial live-backend journey — CREDENTIAL-GATED, skipped without auth state.
//
// Covers login state, import completion, transaction visibility, real chat,
// goal creation, artifact creation/pinning, and overlapping re-import.
// It does not yet prove transaction correction or scenario changes.
//
// Why gated: every step after login needs a real Supabase project, an
// authenticated session, and seeded workspace data. Local .env in this repo
// may be configured, but Supabase magic-link OTP has no deterministic inbox in CI, so
// this spec SKIPS (explicitly, via test.skip with the missing vars listed)
// unless the operator supplies:
//   NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, and
//   E2E_STORAGE_STATE pointing at a Playwright storageState file (or
//   e2e/.auth.json). See e2e/README.md §2 for the login-and-save steps.
// A skip is reported as skipped — never as a pass.
//
// File mapping and artifact proposals are mocked; import, chat, planning,
// and automatic first review use the live backend and configured free model.
import * as fs from "node:fs";
import { test, expect } from "@playwright/test";
import {
  AUGUST_CSV,
  SEPTEMBER_CSV,
  e2eStorageStatePath,
  gatedSkipReason,
  hasSupabaseEnv,
  mockInspectResponse,
} from "./fixtures";

const storageState = e2eStorageStatePath();
if (storageState) test.use({ storageState });

const CAN_RUN =
  hasSupabaseEnv() && storageState !== null && fs.existsSync(storageState);

test.describe("partial core journey (gated: real Supabase, selected AI mocks)", () => {
  test.skip(!CAN_RUN, gatedSkipReason());

  test("authenticate → import → home → ask → goal → mocked analysis → pin artifact → re-import", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    // Mock ONLY the AI-proposing inspect (no-mapping POST). Correction
    // previews carry an explicit mapping and go to the real backend, which
    // is deterministic (no LLM). Artifact-proposal / analysis-start are canned.
    await page.route("**/api/imports/inspect", async (route) => {
      const contentType = route.request().headers()["content-type"] ?? "";
      if (
        route.request().method() === "POST" &&
        !contentType.includes("multipart")
      ) {
        await route.continue();
        return;
      }
      // Multipart uploads without us parsing the body: return the canned AI
      // mapping on the FIRST upload of each file; let explicit-mapping
      // correction previews pass through to the real route. Playwright
      // cannot cheaply distinguish them, so fulfil all multipart inspects
      // with the deterministic mapping — the real mapping validation is
      // covered by lib/csv.test.ts and the confirm step below.
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(mockInspectResponse()),
      });
    });

    await test.step("authenticate: session loads Home, not /login", async () => {
      await page.goto("/");
      await expect(page).not.toHaveURL(/\/login/);
      await expect(
        page.getByRole("heading", { name: "Home" }),
      ).toBeVisible();
    });

    await test.step("upload sample file and confirm AI mapping", async () => {
      await page.goto("/import");
      await page.getByLabel("Financial statement files").setInputFiles({
        name: "august.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(AUGUST_CSV, "utf-8"),
      });
      await expect(page.getByText("august.csv (1 of 1)")).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Continue", exact: true }),
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Continue", exact: true })
        .click();
      const firstImport = page.getByRole("region", { name: "Import history" })
        .locator("article").filter({ hasText: "august.csv" });
      await expect(firstImport.getByText("completed"))
        .toBeVisible({ timeout: 60_000 });
    });

    await test.step("view an imported transaction", async () => {
      await page.goto("/money/transactions");
      await expect(
        page.getByRole("heading", { name: "Transactions" }),
      ).toBeVisible();
      // Deterministic assertion: the salary row from the synthetic fixture
      // is listed server-side (no full-DB client filtering per §7).
      await expect(page.getByText("Salary Acme").first()).toBeVisible();
    });

    await test.step("view Home with trusted metrics", async () => {
      await page.goto("/");
      await expect(
        page.getByRole("heading", { name: "Home" }),
      ).toBeVisible();
      await expect(page.getByRole("heading", { name: "Net worth" })).toBeVisible();
    });

    await test.step("ask a grounded AI question", async () => {
      await page.goto("/ai");
      await page.getByLabel(/ask about your finances/i).fill(
        "How much salary did I receive in August?",
      );
      await page.getByRole("button", { name: "Send" }).click();
      await expect(page.getByText(/2,500|2 500|2500/).first()).toBeVisible({ timeout: 60_000 });
    });

    await test.step("create a goal and view forecast availability", async () => {
      await page.goto("/plan");
      await expect(
        page.getByRole("heading", { name: "Plan" }),
      ).toBeVisible();
      await page.getByPlaceholder("Goal name").fill("E2E Japan");
      await page.getByPlaceholder("Target amount").fill("3500.00");
      await page
        .getByRole("button", { name: "Add goal", exact: true })
        .click();
      await expect(page.getByRole("heading", { name: "E2E Japan" }).first()).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Available to spend" }),
      ).toBeVisible();
    });

    await test.step("complete Deep Analysis (mocked completion)", async () => {
      const jobId = "11111111-1111-1111-1111-111111111111";
      await page.route("**/api/analysis", async (route) => {
        if (route.request().method() === "POST") {
          await route.fulfill({
            status: 202,
            contentType: "application/json",
            body: JSON.stringify({ jobId, status: "queued" }),
          });
        } else {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify([
              {
                id: jobId,
                status: "completed",
                stage: "done",
                error: null,
              },
            ]),
          });
        }
      });
      await page.route(`**/api/analysis/${jobId}`, async (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            id: jobId,
            status: "completed",
            stage: "done",
            error: null,
            analysis: {
              title: "Mocked deterministic review",
              body: "Balances, cash flow and recurring commitments from exact tool results.",
              evidence: { cashflow: "deterministic", transactionsRead: 2 },
            },
          }),
        }),
      );
      await page.goto("/ai");
      await page.getByRole("button", { name: "Run review" }).click();
      await expect(page.getByText("Mocked deterministic review")).toBeVisible();
    });

    await test.step("create and pin a suggested artifact", async () => {
      await page.route("**/api/artifacts/generate", async (route) => {
        const body = route.request().postDataJSON?.() as
          | Record<string, unknown>
          | undefined;
        if (body && body.confirm === true) {
          await route.continue();
        } else {
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              kind: "spending_explorer",
              name: "E2E Spending Explorer",
              rationale: "Deterministic mock proposal; no LLM quota used.",
            }),
          });
        }
      });
      await page.goto("/ai/library");
      await page.getByLabel("What should the tool help with?").fill(
        "compare dining spending this month",
      );
      await page.getByRole("button", { name: "Suggest a tool" }).click();
      await expect(page.getByRole("textbox", { name: "Suggested name" })).toHaveValue("E2E Spending Explorer");
      await page
        .getByRole("button", { name: /Continue.*Create this tool/ })
        .click();
      await expect(page).toHaveURL(/\/ai\/library\/[0-9a-f-]{36}$/);
      await expect(page.getByRole("heading", { name: "E2E Spending Explorer" })).toBeVisible();
      await page.getByRole("button", { name: "Pin to Home" }).click();
      await expect(page.getByRole("button", { name: "Unpin from Home" })).toBeVisible();
    });

    await test.step("submit newer overlapping data", async () => {
      await page.goto("/import");
      await page.getByLabel("Financial statement files").setInputFiles({
        name: "september.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(SEPTEMBER_CSV, "utf-8"),
      });
      await expect(page.getByText("september.csv (1 of 1)")).toBeVisible();
      await page
        .getByRole("button", { name: "Continue", exact: true })
        .click();
      const newerImport = page.getByRole("region", { name: "Import history" })
        .locator("article").filter({ hasText: "september.csv" });
      await expect(newerImport.getByText("completed")).toBeVisible({ timeout: 60_000 });
      await expect(newerImport).toContainText(/2 new.*1 for review/);
      await page.goto("/");
      await expect(
        page.getByRole("heading", { name: "Home" }),
      ).toBeVisible();
      await expect(page.getByText("4 accepted transactions")).toBeVisible();
      await expect(page.getByRole("link", { name: /E2E Spending Explorer/ }).first()).toBeVisible();
    });

  });
});
