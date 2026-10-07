import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import postgres from "postgres";
import { buildPlanningReview, type ReviewTransaction } from "../lib/finance/review";
import { monthPrefix } from "../lib/finance/spending-plans";

test.skip(!process.env.SUPABASE_DB_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, "Requires disposable Supabase auth and database fixtures");
test("native and AI budget completeness follow real classification correction and undo", async ({ browser, baseURL }) => {
  test.setTimeout(180_000);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, connection = new URL(process.env.SUPABASE_DB_URL!);
  const project = new URL(url).hostname.split(".")[0];
  expect(connection.hostname === `db.${project}.supabase.co` || connection.username.endsWith(`.${project}`)).toBe(true);
  const db = postgres(connection.toString(), { ssl: "require", max: 1 });
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const email = `qa-mne009-${randomUUID()}@example.invalid`, password = randomBytes(24).toString("hex");
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { qa_test: "budget-completeness" } });
  expect(created.error).toBeNull();
  const user = created.data.user!.id;
  const recovery = `.qa/budget-completeness-${user}.json`;
  mkdirSync(".qa", { recursive: true }); writeFileSync(recovery, JSON.stringify({ project, user, email, storageObjects: [] }));
  const context = await browser.newContext({ baseURL });
  let workspace: string | undefined;
  try {
    [{ id: workspace }] = await db`select id from public.workspaces where owner_id=${user}`;
    writeFileSync(recovery, JSON.stringify({ project, user, workspace, email, storageObjects: [] }));
    const jar = new Map<string, string>();
    const auth = createServerClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { cookies: { getAll: () => [...jar].map(([name, value]) => ({ name, value })), setAll: values => values.forEach(({ name, value }) => jar.set(name, value)) } });
    expect((await auth.auth.signInWithPassword({ email, password })).error).toBeNull();
    await context.addCookies([...jar].map(([name, value]) => ({ name, value, domain: "localhost", path: "/", sameSite: "Lax" as const })));
    const category = randomUUID(), account = randomUUID(), uncertain = randomUUID(), budget = randomUUID(), name = `Budget completeness ${category.slice(0, 8)}`;
    const month = monthPrefix();
    await db`insert into public.workspace_settings(workspace_id,locale,timezone) values(${workspace!},'en','Europe/Berlin')`;
    await db`insert into public.categories(id,workspace_id,name) values(${category},${workspace!},${name})`;
    await db`insert into public.accounts(id,workspace_id,name,currency_code,type) values(${account},${workspace!},'Synthetic budget account','EUR','checking')`;
    await db`insert into public.transactions(id,workspace_id,account_id,posted_on,description,amount_minor,currency_code,status,kind,category_id,review_reasons) values(${randomUUID()},${workspace!},${account},${month + '-01'},'Confirmed synthetic expense',-1000,'EUR','posted','ordinary',${category},'{}'),(${uncertain},${workspace!},${account},${month + '-02'},'Uncertain synthetic expense',-20000,'EUR','posted','ordinary',${category},'{source_type}')`;
    await db`insert into public.spending_plans(id,workspace_id,category_id,currency_code,limit_minor,rollover_from) values(${budget},${workspace!},${category},'EUR',10000,${month + '-01'})`;
    const page = await context.newPage();
    async function compare(partial: boolean) {
      // The AI operation receives the same owner-scoped effective records as its loader.
      const result = await auth.from("effective_transactions").select("id,amount_minor::text,currency_code,status,kind,category_id,posted_on,merchant_id,review_reasons").eq("workspace_id", workspace!);
      expect(result.error).toBeNull();
      const plans = await auth.from("spending_plans").select("id,category_id,currency_code,limit_minor::text,enabled,rollover,rollover_from").eq("workspace_id", workspace!);
      expect(plans.error).toBeNull();
      const ai = buildPlanningReview({ today: month + '-07', goals: [], allocations: [], categories: [{ id: category, name }], budgets: plans.data!, transactions: result.data as ReviewTransaction[] }).budgets[0];
      expect(ai).toMatchObject({ partial, spentMinor: partial ? "1000" : "21000", remainingMinor: partial ? null : "-11000", overLimit: partial ? null : true });
      await page.goto("/plan/spending");
      const card = page.locator("li").filter({ has: page.getByRole("heading", { name, exact: true }) });
      await expect(card).toContainText(partial ? "EUR 10.00 of EUR 100.00" : "EUR 210.00 of EUR 100.00");
      if (partial) {
        await expect(card).toContainText("remaining budget is unknown");
        await expect(card).not.toContainText("left"); await expect(card).not.toContainText("over plan");
        await expect(card.getByRole("link", { name: "Review classifications" })).toHaveAttribute("href", "/import");
        await expect(card.locator("progress")).toHaveCount(0);
      } else await expect(card).toContainText("EUR 110.00 over plan");
    }
    for (const rollover of [false, true]) {
      if (rollover) await db`update public.spending_plans set rollover=true,version=version+1 where id=${budget} and workspace_id=${workspace!}`;
      await compare(true);
      const [{ version }] = await db`select version from public.transactions where id=${uncertain}`;
      expect((await auth.rpc("resolve_transaction_classification", { p_transaction_id: uncertain, p_expected_version: version, p_kind: "ordinary", p_fee_included: false })).error).toBeNull();
      await compare(false);
      const [event] = await db`select id from public.correction_events where transaction_id=${uncertain} and not undone order by created_at desc limit 1`;
      const [corrected] = await db`select version from public.transactions where id=${uncertain}`;
      expect((await auth.rpc("undo_transaction_classification", { p_event_id: event.id, p_expected_version: corrected.version })).error).toBeNull();
      await compare(true);
    }
    expect((await db`select amount_minor::text,review_reasons from public.transactions where id=${uncertain}`)[0]).toMatchObject({ amount_minor: "-20000", review_reasons: ["source_type"] });
    expect((await db`select count(*)::int as count from public.correction_events where workspace_id=${workspace!} and undone`)[0].count).toBe(2);
  } finally {
    await context.close();
    if (workspace) await db.begin(async tx => {
      for (const table of ["correction_events", "spending_plans", "spending_plan_limits", "transactions", "accounts", "categories", "workspace_settings", "planning_events"]) await tx`delete from ${tx("public." + table)} where workspace_id=${workspace!}`;
      const tables = await tx`select table_name from information_schema.columns where table_schema='public' and column_name='workspace_id'`;
      for (const { table_name } of tables) expect((await tx`select count(*)::int as count from ${tx("public." + table_name)} where workspace_id=${workspace!}`)[0].count, table_name).toBe(0);
      expect((await tx`select count(*)::int as count from storage.objects where owner_id=${user}`)[0].count).toBe(0);
      await tx`delete from public.workspaces where id=${workspace!} and owner_id=${user}`;
    });
    expect((await admin.auth.admin.deleteUser(user)).error).toBeNull();
    expect((await db`select count(*)::int as count from auth.users where id=${user}`)[0].count).toBe(0);
    unlinkSync(recovery); await db.end();
  }
});
