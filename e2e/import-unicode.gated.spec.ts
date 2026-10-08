import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { e2eStorageStatePath, gatedSkipReason, hasSupabaseEnv } from "./fixtures";

const state = e2eStorageStatePath();
if (state) test.use({ storageState: state });
test.skip(!hasSupabaseEnv() || !state || !process.env.SUPABASE_DB_URL, gatedSkipReason());

test("explicit Unicode merchants import without splitting a character and retain their original source", async ({ page }) => {
  test.setTimeout(180_000);
  const suffix = randomUUID(), filename = `synthetic-unicode-${suffix}.csv`;
  const merchant = "x".repeat(99) + "🛒 original suffix";
  const date = new Date().toISOString().slice(0, 10);
  const csv = `Date,Description,Amount,Currency,Merchant\n${date},Synthetic Unicode ${suffix},-12.34,EUR,${merchant}\n`;
  // Only the initial unavailable mapping suggestion is synthetic. The explicit
  // correction preview, confirmation, Workflow and persisted rows are real.
  await page.route("**/api/imports/inspect", async route => {
    if (route.request().postData()?.includes('name="mapping"')) return route.continue();
    return route.fulfill({ json: { headers: ["Date", "Description", "Amount", "Currency", "Merchant"],
      sample: [], mapping: null, preview: null, aiError: "Synthetic unavailable suggestion" } });
  });
  await page.goto("/import");
  const picker = page.getByLabel("Financial statement files");
  await expect(picker).toBeEnabled();
  await picker.setInputFiles({ name: filename, mimeType: "text/csv", buffer: Buffer.from(csv) });
  await expect(page.getByText("Automatic interpretation unavailable. Choose the columns below.")).toBeVisible();
  await page.getByLabel("Account name", { exact: true }).fill(`Unicode QA ${suffix}`);
  await page.getByRole("combobox", { name: "Source numeric convention" }).selectOption("decimal-dot");
  for (const column of ["Date", "Description", "Amount", "Currency", "Merchant"]) {
    await page.getByRole("combobox", { name: column, exact: true }).selectOption(column);
  }
  await page.getByRole("button", { name: "Preview correction", exact: true }).click();
  await expect(page.getByText("1 accepted", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const history = page.getByRole("region", { name: "Import history" }).locator("article").filter({ hasText: filename });
  await expect(history.getByRole("status")).toHaveText("completed", { timeout: 120_000 });
  await expect(history).toContainText("1 new");
  const endpoint = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!), connection = new URL(process.env.SUPABASE_DB_URL!);
  const project = endpoint.hostname.split(".")[0];
  expect(connection.hostname === `db.${project}.supabase.co` || connection.username.endsWith(`.${project}`)).toBe(true);
  const db = postgres(connection.toString(), { ssl: "require", max: 1 });
  try {
    const [source] = await db`select s.original_row, m.name, t.amount_minor from public.imports i
      join public.source_transactions s on s.import_id=i.id
      join public.transaction_sources link on link.source_transaction_id=s.id
      join public.transactions t on t.id=link.transaction_id
      join public.merchants m on m.id=t.merchant_id where i.filename=${filename}`;
    expect(source.original_row.Merchant).toBe(merchant);
    expect(source.name).toBe("x".repeat(99) + "🛒");
    expect(String(source.amount_minor)).toBe("-1234");
  } finally { await db.end(); }
});
