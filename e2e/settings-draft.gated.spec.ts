import { expect, test } from "@playwright/test";
import { e2eStorageStatePath, gatedSkipReason, hasSupabaseEnv } from "./fixtures";

const state = e2eStorageStatePath();
if (state) test.use({ storageState: state });
test.skip(!hasSupabaseEnv() || !state, gatedSkipReason());

test("rejected preferences retain every edited field so the timezone can be corrected and saved", async ({ page }) => {
  await page.goto("/settings");
  const form = page.locator("form").filter({ has: page.getByRole("button", { name: "Save preferences", exact: true }) });
  const timezone = form.getByRole("combobox", { name: "Timezone", exact: true });
  const locale = form.getByRole("textbox", { name: "Date and number locale", exact: true });
  const theme = form.getByRole("combobox", { name: "Appearance", exact: true });
  const cadence = form.getByRole("combobox", { name: "In-app summary preference", exact: true });
  const time = form.getByLabel("Preferred local time", { exact: true });
  const imports = form.locator('input[name="ai_data_scopes"][value="imports"]');
  const original = { timezone: await timezone.inputValue(), locale: await locale.inputValue(), theme: await theme.inputValue(), cadence: await cadence.inputValue(), time: await time.inputValue(), imports: await imports.isChecked() };
  const edited = { timezone: original.timezone === "UTC" ? "Europe/Berlin" : "UTC", locale: original.locale === "de-DE" ? "en-GB" : "de-DE", theme: original.theme === "dark" ? "light" : "dark", cadence: original.cadence === "weekly" ? "none" : "weekly", time: original.time === "14:25" ? "15:25" : "14:25", imports: !original.imports };
  async function fill(values: typeof original) {
    await timezone.fill(values.timezone); await locale.fill(values.locale);
    await theme.selectOption(values.theme); await cadence.selectOption(values.cadence);
    await time.fill(values.time); await imports.setChecked(values.imports);
  }
  async function expectValues(values: typeof original) {
    await expect(timezone).toHaveValue(values.timezone); await expect(locale).toHaveValue(values.locale);
    await expect(theme).toHaveValue(values.theme); await expect(cadence).toHaveValue(values.cadence);
    await expect(time).toHaveValue(values.time); await expect(imports).toBeChecked({ checked: values.imports });
  }
  try {
    await fill({ ...edited, timezone: "Invalid/Timezone" });
    await form.getByRole("button", { name: "Save preferences", exact: true }).click();
    await expect(form.getByRole("alert")).toContainText("Choose a valid timezone");
    await expectValues({ ...edited, timezone: "Invalid/Timezone" });
    await timezone.fill(edited.timezone);
    await form.getByRole("button", { name: "Save preferences", exact: true }).click();
    await expect(form.getByRole("status")).toContainText("Preferences saved.");
    await expectValues(edited);
    await page.reload();
    await expectValues(edited);
  } finally {
    await page.goto("/settings");
    await fill(original);
    await form.getByRole("button", { name: "Save preferences", exact: true }).click();
    await expect(form.getByRole("status")).toContainText("Preferences saved.");
  }
});
