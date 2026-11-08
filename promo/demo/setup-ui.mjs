// Finishes the demo workspace through Moneo's own screens (budgets, goal, regular payments), then syncs Scalable.
//   node --env-file=.env promo/demo/setup-ui.mjs
import { APP, openBrowser } from "./recorder.mjs";

const { browser, page } = await openBrowser();
const shot = name => page.screenshot({ path: `promo/out/check/${name}.png` });

await page.goto(`${APP}/plan/spending`);
for (const [category, limit] of [["Groceries", "450.00"], ["Eating out", "200.00"], ["Going out", "120.00"], ["Transport", "90.00"], ["Travel", "300.00"], ["Shopping", "150.00"]]) {
  await page.getByRole("combobox", { name: "Category", exact: true }).selectOption({ label: category });
  await page.getByRole("textbox", { name: "Monthly limit", exact: true }).fill(limit);
  await page.getByRole("button", { name: "Set limit", exact: true }).click();
  await page.locator("li").filter({ has: page.getByRole("heading", { name: category, exact: true }) }).first().waitFor();
  console.log("budget", category);
}
await shot("spending");

await page.goto(`${APP}/plan`);
await page.getByPlaceholder("Goal name", { exact: true }).fill("House deposit");
await page.getByPlaceholder("Target amount", { exact: true }).fill("40000.00");
await page.getByRole("button", { name: "Add goal", exact: true }).click();
const goal = page.locator("article").filter({ has: page.getByRole("heading", { name: "House deposit", exact: true }) });
await goal.waitFor();
await goal.getByText("Edit goal and contribution plan", { exact: true }).click();
await goal.getByLabel("Planned monthly contribution (EUR)", { exact: true }).fill("600.00");
await goal.getByLabel("First contribution date", { exact: true }).fill("2026-12-01");
await goal.getByLabel("Saved so far (EUR)", { exact: true }).fill("18400.00");
await goal.getByLabel("Savings as of", { exact: true }).fill("2026-11-01");
await goal.getByLabel("Target date", { exact: true }).fill("2029-12-01");
await goal.getByRole("button", { name: "Save goal plan", exact: true }).click();
await goal.getByText("Expected completion").first().waitFor();
await page.waitForTimeout(1000);
await page.screenshot({ path: "promo/out/check/plan.png", fullPage: true });

await page.goto(`${APP}/money/recurring`);
await page.waitForTimeout(3000);
await page.screenshot({ path: "promo/out/check/recurring.png", fullPage: true });
await page.goto(`${APP}/settings`);
await page.waitForTimeout(2000);
await page.screenshot({ path: "promo/out/check/settings.png", fullPage: true });
await page.goto(`${APP}/`);
await page.waitForTimeout(5000);
await page.screenshot({ path: "promo/out/check/home.png", fullPage: true });
await browser.close();
