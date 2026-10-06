import { expect, test, type Locator, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import postgres from "postgres";

// MNE-044: representative Money/import surfaces keep 4.5:1 normal-text
// contrast in persisted light, dark and system appearance. Probes read actual
// computed styles (including the compiled globals.css dark overrides) and let
// the browser canvas resolve every color, so the same assertions fail on the
// old hard-coded slate-on-remapped-card pairs and pass on the shared semantic
// foreground/background/border tokens. Selectors use roles/text, not class
// names, so they survive the token swap. Plan is intentionally omitted:
// /plan is unrunnable until the MNE-003 covered_transactions deployment lands
// (that route belongs to MNE005). Reported as unverified in .qa/mne044-report.md.
test.skip(!process.env.SUPABASE_DB_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, "Requires real disposable Supabase authentication");

type RGB = [number, number, number];

// The browser itself resolves every computed color (oklch, lab, color-mix)
// through a 1px canvas: no hand-rolled color math, failures stay loud.
async function probeColors(page: Page, target: Locator): Promise<{ fg: RGB; bg: RGB }> {
  return target.evaluate((element) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1; canvas.height = 1;
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    const read = (css: string): [number, number, number, number] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = "#010203";
      ctx.fillStyle = css;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
      if (r === 1 && g === 2 && b === 3) throw new Error(`canvas could not resolve color: ${css}`);
      return [r, g, b, a / 255];
    };
    const over = (top: [number, number, number, number], bottom: RGB): RGB => {
      const a = top[3];
      return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a)];
    };
    const chain: string[] = [];
    let node: Element | null = element;
    while (node) {
      chain.push(getComputedStyle(node).backgroundColor);
      node = node.parentElement;
    }
    let bg: RGB = [255, 255, 255];
    for (let i = chain.length - 1; i >= 0; i--) bg = over(read(chain[i]), bg);
    return { fg: over(read(getComputedStyle(element).color), bg), bg };
  });
}

function ratio(fg: RGB, bg: RGB): number {
  const luminance = ([r, g, b]: RGB) => {
    const f = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const a = luminance(fg), b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

async function expectReadable(page: Page, target: Locator, label: string) {
  const { fg, bg } = await probeColors(page, target);
  const value = ratio(fg, bg);
  const theme = await page.locator("html").getAttribute("data-theme");
  expect(value, `${label} [theme=${theme}]: rgb(${fg.map(Math.round)}) on rgb(${bg.map(Math.round)}) = ${value.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
}

test("money and import text stays readable in persisted light, dark and system themes", async ({ browser, baseURL }) => {
  test.setTimeout(240_000);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, connection = new URL(process.env.SUPABASE_DB_URL!);
  const project = new URL(url).hostname.split(".")[0];
  expect(connection.hostname === `db.${project}.supabase.co` || connection.username.endsWith(`.${project}`)).toBe(true);
  const db = postgres(connection.toString(), { ssl: "require", max: 1 });
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = `qa-${randomUUID()}@example.invalid`, password = randomBytes(24).toString("hex");
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { qa_test: "theme-contrast" } });
  expect(created.error).toBeNull();
  const user = created.data.user!.id;
  const [workspace] = await db`select id from public.workspaces where owner_id=${user}`;
  const recovery = `.qa/theme-contrast-${user}.json`;
  mkdirSync(".qa", { recursive: true }); writeFileSync(recovery, JSON.stringify({ project, user, workspace: workspace.id }));
  const account = randomUUID(), outflow = randomUUID(), income = randomUUID(), view = randomUUID(), badView = randomUUID();
  const outDesc = "QA dark coffee", inDesc = "QA dark salary", viewName = "QA Contrast";
  const signIn = async (context: { addCookies: (cookies: { name: string; value: string; domain: string; path: string; sameSite: "Lax" }[]) => Promise<void> }) => {
    const jar = new Map<string, string>();
    const auth = createServerClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { cookies: { getAll: () => [...jar].map(([name, value]) => ({ name, value })), setAll: (values) => values.forEach(({ name, value }) => jar.set(name, value)) } });
    expect((await auth.auth.signInWithPassword({ email, password })).error).toBeNull();
    await context.addCookies([...jar].map(([name, value]) => ({ name, value, domain: "localhost", path: "/", sameSite: "Lax" as const })));
  };
  const context = await browser.newContext({ baseURL });
  try {
    await signIn(context);
    await db`insert into public.accounts(id,workspace_id,name,currency_code,type) values(${account},${workspace.id},'QA cash','EUR','checking')`;
    await db`insert into public.transactions(id,workspace_id,account_id,posted_on,description,amount_minor,currency_code,status,kind) values
      (${outflow},${workspace.id},${account},'2026-09-10',${outDesc},'-2500','EUR','posted','ordinary'),
      (${income},${workspace.id},${account},'2026-09-11',${inDesc},'180000','EUR','posted','ordinary')`;
    await db`insert into public.transaction_views(id,workspace_id,name,filters) values
      (${view},${workspace.id},${viewName},${db.json({ status: "posted" })}),
      (${badView},${workspace.id},'QA bad scope',${db.json({ tag: "x".repeat(41) })})`;
    const page = await context.newPage();
    const outRow = page.locator("tbody tr", { hasText: outDesc });
    const inRow = page.locator("tbody tr", { hasText: inDesc });

    async function expectMoneyReadable(theme: string) {
      await page.goto("/money/transactions");
      await expect(page.getByText("2 shown", { exact: true })).toBeVisible();
      await expectReadable(page, page.getByRole("link", { name: outDesc }), `${theme} description`);
      await expectReadable(page, outRow.locator("td").last(), `${theme} negative amount`);
      await expectReadable(page, inRow.locator("td").last(), `${theme} positive amount`);
      await expectReadable(page, page.getByLabel("Search descriptions"), `${theme} filter input`);
      await expectReadable(page, page.getByRole("link", { name: viewName }), `${theme} saved-view label`);
      await expectReadable(page, page.getByText("2 shown", { exact: true }), `${theme} muted count`);
      await expectReadable(page, page.getByRole("columnheader", { name: "Description" }), `${theme} table header`);
      await expectReadable(page, outRow.getByText("posted", { exact: true }), `${theme} status badge`);
      await expectReadable(page, outRow.getByText("ordinary", { exact: true }), `${theme} kind badge`);
      await page.getByRole("link", { name: viewName }).click();
      await expect(page.getByText("(open)", { exact: true })).toBeVisible();
      await page.goto(`/money/transactions?view=${badView}`);
      await expectReadable(page, page.locator('section[aria-label="Invalid saved view"]').getByRole("alert"), `${theme} saved-view error`);
    }

    // Read-only Plan probes: this route belongs to MNE005 (no edits there),
    // readable now that the MNE-003 covered_transactions columns deployed.
    // A balance-free workspace deterministically shows "Forecast unavailable".
    async function expectPlanReadable(theme: string) {
      await page.goto("/plan");
      await expect(page.getByRole("heading", { name: "Financial horizon & runway" })).toBeVisible();
      await expectReadable(page, page.getByText("Explore your forecast, cash reservations, and changes to your plan.", { exact: true }), `${theme} plan subtitle`);
      await expect(page.getByText("Forecast unavailable", { exact: false })).toBeVisible();
      await expectReadable(page, page.getByText("Forecast unavailable", { exact: false }), `${theme} plan unavailable`);
    }

    await expectMoneyReadable("light");
    await expectPlanReadable("light");
    await page.goto("/money/transactions");
    await expect(page.getByText("2 shown", { exact: true })).toBeVisible();
    await page.screenshot({ path: ".qa/mne044-transactions-light.png" });
    await page.goto("/settings");
    const appearance = page.getByRole("combobox", { name: "Appearance", exact: true });
    const originalTheme = await appearance.inputValue();
    await appearance.selectOption("dark");
    await page.getByRole("button", { name: "Save preferences", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Preferences saved");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expectMoneyReadable("dark");
    await expectPlanReadable("dark");
    await page.goto("/import");
    await expect(page.getByRole("heading", { name: "Import financial data" })).toBeVisible();
    await expectReadable(page, page.getByText("Choose CSV or XLSX statements.", { exact: false }), "dark import muted");
    await page.goto("/money/transactions");
    await expect(page.getByText("2 shown", { exact: true })).toBeVisible();
    await page.screenshot({ path: ".qa/mne044-transactions-dark.png", fullPage: true });
    await page.goto("/settings");
    await page.getByRole("combobox", { name: "Appearance", exact: true }).selectOption(originalTheme);
    await page.getByRole("button", { name: "Save preferences", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Preferences saved");
    await page.close();

    const systemContext = await browser.newContext({ baseURL, colorScheme: "dark" });
    try {
      await signIn(systemContext);
      const system = await systemContext.newPage();
      await system.goto("/settings");
      await system.getByRole("combobox", { name: "Appearance", exact: true }).selectOption("system");
      await system.getByRole("button", { name: "Save preferences", exact: true }).click();
      await expect(system.getByRole("status")).toContainText("Preferences saved");
      await system.goto("/money/transactions");
      await expect(system.locator("html")).toHaveAttribute("data-theme", "dark");
      await expectReadable(system, system.getByRole("link", { name: outDesc }), "system-dark description");
      await expectReadable(system, system.locator("tbody tr", { hasText: outDesc }).locator("td").last(), "system-dark negative amount");
      await system.close();
    } finally {
      await systemContext.close().catch(() => {});
    }
  } finally {
    await context.close().catch(() => {});
    await db.begin(async (tx) => {
      for (const table of ["correction_events", "money_metadata_events", "transactions", "transaction_views", "accounts"]) await tx`delete from ${tx("public." + table)} where workspace_id=${workspace.id}`;
      await tx`delete from public.workspaces where id=${workspace.id} and owner_id=${user}`;
    });
    expect((await admin.auth.admin.deleteUser(user)).error).toBeNull();
    unlinkSync(recovery); await db.end();
  }
});
