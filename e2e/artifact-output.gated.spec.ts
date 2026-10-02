import { test, expect } from "@playwright/test";
import { e2eStorageStatePath, gatedSkipReason, hasSupabaseEnv } from "./fixtures";
const state=e2eStorageStatePath();if(state)test.use({storageState:state});test.skip(!hasSupabaseEnv()||!state,gatedSkipReason());
test("data-dependent live output is rejected without losing the working version",async({page})=>{
  test.setTimeout(90_000);await page.goto("/ai/library");
  const create=page.locator("form").filter({has:page.getByLabel("Custom Comparison",{exact:true})});
  await create.getByLabel("Custom Comparison",{exact:true}).fill(`Output QA ${crypto.randomUUID().slice(0,8)}`);
  await create.getByRole("button",{name:"Create",exact:true}).click();
  const editor=page.getByRole("region",{name:"Edit calculator version"});
  await editor.locator(".cm-content").fill(`input=>({summary:"x".repeat(Number(input.params.size||1))})`);
  await editor.getByLabel("Manifest (JSON)").fill(JSON.stringify({kind:"custom_comparison",runtime:"quickjs-calculator-v1",sdk:[],params:{size:{type:"number",min:1,max:1000,default:1}},renderer:"trusted"}));
  await editor.getByRole("button",{name:"Save new version",exact:true}).click();
  const output=page.getByRole("region",{name:"Generated calculator output"});
  await expect(output.getByText("x",{exact:true})).toBeVisible({timeout:20_000});
  await output.getByLabel("size",{exact:true}).fill("600");
  await expect(output.getByRole("status")).toContainText("Output summary is too long",{timeout:10_000});
  await expect(output.getByRole("button",{name:"Export PNG",exact:true})).toBeDisabled();
  await output.getByLabel("size",{exact:true}).fill("1");
  await expect(output.getByText("x",{exact:true})).toBeVisible();
});

test("saved calculator months load matching evidence and unsaved changes cannot relabel it", async ({ page }) => {
  await page.goto("/ai/library");
  const create = page.locator("form").filter({ has: page.getByLabel("Custom Tracker", { exact: true }) });
  await create.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(/\/ai\/library\/[0-9a-f-]{36}$/);
  const id = new URL(page.url()).pathname.split("/").at(-1)!;
  const response = await page.request.post(`/api/artifacts/${id}/versions`, { data: {
    source: `(input) => { const c = input.snapshot.cashflow; if (!c || c.unavailable) return { unavailable: "No cashflow" }; return { summary: (c.from || "Period") + " to " + (c.to || "end"), numbers: { spendingMinor: c.spendingMinor } }; }`,
    manifest: { kind: "custom_tracker", runtime: "quickjs-calculator-v1", sdk: ["cashflow"], params: { month: { type: "string", default: "2026-09", maxLength: 7 } }, renderer: "trusted" },
  } });
  expect(response.ok(), await response.text()).toBe(true);
  await page.reload();
  const output = page.getByRole("region", { name: "Generated calculator output" });
  await expect(output).toContainText("2026-09-01 to 2026-09-30");
  await output.getByLabel("month", { exact: true }).fill("2026-08");
  await expect(output).toContainText("Save inputs to load financial evidence for the selected month.");
  await expect(output).not.toContainText("2026-09-01 to 2026-09-30");
  await output.getByRole("button", { name: "Save inputs", exact: true }).click();
  await expect(output).toContainText("2026-08-01 to 2026-08-31");
});
