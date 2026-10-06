import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import postgres from "postgres";
import { FALLBACK_CALCULATORS } from "../lib/artifacts/templates";

test.skip(!process.env.SUPABASE_DB_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, "Requires disposable synthetic auth and reviewed migration head");
test("Home and Plan retain paying-account gaps, timely funding, donor protections and recurring bills", async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, connection = new URL(process.env.SUPABASE_DB_URL!);
  const project = new URL(url).hostname.split(".")[0];
  expect(connection.hostname === `db.${project}.supabase.co` || connection.username.endsWith(`.${project}`)).toBe(true);
  const db = postgres(connection.toString(), { ssl: "require", max: 1 });
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL });
  const runId = randomUUID(), recovery = `.qa/mne005-fixture-${runId}.json`;
  let user: string | undefined, workspace: string | undefined;
  const checking = randomUUID(), savings = randomUUID(), goal = randomUUID();
  try {
    const email = `qa-mne005-${runId}@example.invalid`, password = randomBytes(24).toString("hex");
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { qa_test: "mne005-native" } });
    expect(created.error).toBeNull(); user = created.data.user!.id;
    mkdirSync(".qa", { recursive: true }); writeFileSync(recovery, JSON.stringify({ project, user }));
    [{ id: workspace }] = await db`select id from public.workspaces where owner_id=${user}`;
    writeFileSync(recovery, JSON.stringify({ project, user, workspace, checking, savings, goal }));
    const now = new Date().toISOString(), today = now.slice(0, 10);
    const tomorrow = new Date(Date.parse(`${today}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
    const late = new Date(Date.parse(`${today}T00:00:00Z`) + 2 * 86400000).toISOString().slice(0, 10);
    await db.begin(async tx => {
      await tx`insert into public.workspace_settings(workspace_id,timezone,locale,ai_data_scopes,summary_cadence) values(${workspace!},'UTC','en-GB','{}','none') on conflict(workspace_id) do update set timezone='UTC',locale='en-GB',ai_data_scopes='{}',summary_cadence='none'`;
      await tx`insert into public.accounts(id,workspace_id,name,currency_code,type) values(${checking},${workspace!},'Checking QA','EUR','checking'),(${savings},${workspace!},'Savings QA','EUR','savings')`;
      for (const [account, amount] of [[checking, "10000"], [savings, "100000"]]) await tx`insert into public.balance_snapshots(workspace_id,account_id,amount_minor,currency_code,as_of,provenance,boundary_kind,covered_transactions,actor_id) values(${workspace!},${account},${amount},'EUR',${now},'synthetic reviewed opening','reviewed_activity','[]'::jsonb,${user!})`;
      await tx`insert into public.financial_assumptions(workspace_id,account_id,kind,name,amount_minor,currency_code,cadence,starts_on,source,confirmed,enabled) values(${workspace!},${checking},'expense','Recurring bill QA',-50000,'EUR','monthly',${tomorrow},'recurring_confirmed',true,true)`;
      await tx`insert into public.forecast_preferences(workspace_id,currency_code,uncertainty_bps) values(${workspace!},'EUR',0)`;
      await tx`insert into public.goals(id,workspace_id,name,target_minor,currency_code) values(${goal},${workspace!},'Protected savings QA',90000,'EUR')`;
    });
    const cookies = new Map<string, string>();
    const auth = createServerClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { cookies: { getAll: () => [...cookies].map(([name, value]) => ({ name, value })), setAll: values => values.forEach(({ name, value }) => cookies.set(name, value)) } });
    expect((await auth.auth.signInWithPassword({ email, password })).error).toBeNull();
    const base = new URL(testInfo.project.use.baseURL!);
    await context.addCookies([...cookies].map(([name, value]) => ({ name, value, domain: base.hostname, path: "/", sameSite: "Lax" as const })));
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const providerCalls: string[] = [];
    await context.route(/openrouter\.ai/, route => { providerCalls.push(route.request().url()); return route.abort(); });
    await page.goto(`/?account=${checking}`);
    const home = page.getByRole("region", { name: "Spending and planning" });
    await expect(home).toContainText("EUR 600.00"); await expect(home).toContainText("Checking QA funding shortfall: EUR 400.00");
    await expect(home).toContainText(tomorrow); await expect(home).toContainText("-EUR 400.00");
    await expect(page.getByText("Recurring bill QA", { exact: false }).first()).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("home-checking.png"), fullPage: true });
    await home.getByRole("combobox", { name: "Paying account", exact: true }).selectOption(savings);
    await home.getByRole("button", { name: "Evaluate account", exact: true }).click();
    await expect(home).toContainText("Checking QA funding shortfall: EUR 400.00");
    await page.goto(`/plan?account=${checking}&horizon=3`);
    const forecast = page.locator("section").filter({ has: page.getByRole("heading", { name: "Liquid balance horizon", exact: true }) });
    await expect(forecast).toContainText("Checking QA funding shortfall: EUR 400.00"); await expect(forecast).toContainText("EUR 600.00");
    await expect(forecast).toContainText("Recurring bill QA"); await expect(forecast).toContainText(tomorrow);
    await forecast.getByRole("combobox", { name: "Fund from (optional)", exact: true }).selectOption(savings);
    await forecast.getByLabel("Funding date", { exact: true }).fill(tomorrow);
    await forecast.getByLabel("Funding amount (EUR minor units)", { exact: true }).fill("40000");
    await forecast.getByRole("button", { name: "Evaluate account", exact: true }).click();
    await expect(forecast).not.toContainText("Checking QA funding shortfall"); await expect(forecast).toContainText("EUR 600.00");
    await expect(forecast).toContainText("Internal funding in"); await page.screenshot({ path: testInfo.outputPath("plan-timely.png"), fullPage: true });
    await forecast.getByLabel("Funding date", { exact: true }).fill(late); await forecast.getByRole("button", { name: "Evaluate account", exact: true }).click();
    await expect(forecast).toContainText("Checking QA funding shortfall: EUR 400.00"); await expect(forecast.getByLabel("Funding date", { exact: true })).toHaveValue(late);
    await page.screenshot({ path: testInfo.outputPath("plan-late.png"), fullPage: true });
    // Exact disposable donor reservation: only EUR100 can leave savings without invading protected funds.
    await db`insert into public.goal_allocations(workspace_id,goal_id,account_id,amount_minor) values(${workspace!},${goal},${savings},90000)`;
    await forecast.getByLabel("Funding date", { exact: true }).fill(tomorrow); await forecast.getByRole("button", { name: "Evaluate account", exact: true }).click();
    await expect(forecast).toContainText("Savings QA funding shortfall: EUR 300.00"); await expect(forecast).toContainText("Goal reservations: EUR 900.00");
    await expect(forecast).not.toContainText("Checking QA funding shortfall");
    await page.screenshot({ path: testInfo.outputPath("plan-donor-protected.png"), fullPage: true });
    await page.goto(`/?account=${savings}`); await expect(home).toContainText("Protected funds: EUR 900.00"); await expect(home).toContainText("Checking QA funding shortfall: EUR 400.00");
    expect((await db`select count(*)::int as count from public.transactions where workspace_id=${workspace!}`)[0].count).toBe(0);
    expect((await db`select count(*)::int as count from public.scenario_overrides where workspace_id=${workspace!}`)[0].count).toBe(0);
    expect((await db`select amount_minor::text from public.balance_snapshots where account_id=${checking}`)[0].amount_minor).toBe("10000");
    // Same disposable accounts, both UUID-order placements of the funded account.
    await db`delete from public.goal_allocations where workspace_id=${workspace!}`;
    await db`update public.financial_assumptions set removed_at=now() where workspace_id=${workspace!}`;
    await db`update public.forecast_preferences set safety_buffer_minor=10000 where workspace_id=${workspace!}`;
    for (const funded of [checking, savings]) {
      await db`update public.balance_snapshots set amount_minor=case when account_id=${funded} then 100000 else 0 end where workspace_id=${workspace!}`;
      await page.goto(`/?account=${funded}`);
      await expect(home).toContainText("Workspace buffer: EUR 100.00");
      await expect(home).not.toContainText("funding shortfall");
      await expect(home.locator("div").filter({ has: page.getByRole("heading", { name: /Chosen-account headroom/ }) }).last()).toContainText("EUR 900.00");
      await page.goto(`/plan?account=${funded}&horizon=3`);
      await expect(forecast).toContainText("Workspace buffer: EUR 100.00");
      await expect(forecast).not.toContainText("funding shortfall:");
      await expect(forecast.getByRole("heading", { name: /Chosen-account headroom/ }).locator("..")).toContainText("EUR 900.00");
    }
    await page.screenshot({ path: testInfo.outputPath("plan-workspace-buffer.png"), fullPage: true });
    // Standalone validated deterministic fallback, no generation provider or 006 RPC.
    await db`update public.workspace_settings set ai_data_scopes=ARRAY['accounts','transactions','planning']::text[] where workspace_id=${workspace!}`;
    await db`update public.forecast_preferences set spending_account_id=${checking}, safety_buffer_minor=0 where workspace_id=${workspace!}`;
    await db`update public.balance_snapshots set amount_minor=case when account_id=${checking} then 10000 else 100000 end where workspace_id=${workspace!}`;
    await db`update public.financial_assumptions set removed_at=null where workspace_id=${workspace!}`;
    const artifact = randomUUID(), version = randomUUID();
    const fallback = FALLBACK_CALCULATORS.trip_planner;
    await db`insert into public.artifacts(id,workspace_id,kind,name,permissions) values(${artifact},${workspace!},'trip_planner','Synthetic dated trip QA','["balances","forecast"]'::jsonb)`;
    // First exercise only the trusted builtin; no CalculatorPanel/fallback is present.
    await db`insert into public.artifact_versions(id,workspace_id,artifact_id,version,source,manifest,status) values(${version},${workspace!},${artifact},1,'(input) => ({ready:true})','{"kind":"trip_planner","runtime":"trusted","sdk":[],"params":{},"renderer":"trusted"}'::jsonb,'validated')`;
    await db`update public.artifacts set active_version_id=${version} where id=${artifact} and workspace_id=${workspace!}`;
    await db`insert into public.artifact_state(artifact_id,workspace_id,state) values(${artifact},${workspace!},'{"costMinor":10000}'::jsonb)`;
    await page.goto(`/ai/library/${artifact}`);
    const nativeTrip = page.locator("section").filter({ has: page.getByRole("heading", { name: "Trip cost", exact: true }) });
    await expect(page.getByRole("region", { name: "Generated calculator output" })).toHaveCount(0);
    await expect(nativeTrip).toContainText("Chosen-account headroom"); await expect(nativeTrip).toContainText("Aggregate headroom: EUR 600.00");
    await expect(nativeTrip).toContainText(`${checking} funding shortfall: EUR 400.00`);
    await expect(nativeTrip).toContainText("Recurring bill QA"); await expect(nativeTrip).toContainText(tomorrow);
    await expect(nativeTrip).toContainText("Dated trip evidence"); await expect(nativeTrip).toContainText(`${checking} funding shortfall: EUR 500.00`);
    await expect(nativeTrip).toContainText("No automatic funding"); await expect(nativeTrip).not.toContainText("Available to spend now");
    await page.screenshot({ path: testInfo.outputPath("artifact-builtin-only-checking.png"), fullPage: true });
    // Nonzero workspace buffer and either UUID-order position, still builtin-only.
    await db`update public.financial_assumptions set removed_at=now() where workspace_id=${workspace!}`;
    for (const funded of [checking, savings]) {
      await db`update public.forecast_preferences set spending_account_id=${funded}, safety_buffer_minor=10000 where workspace_id=${workspace!}`;
      await db`update public.balance_snapshots set amount_minor=case when account_id=${funded} then 100000 else 0 end where workspace_id=${workspace!}`;
      await page.reload(); await expect(nativeTrip).toContainText("Workspace buffer: EUR 100.00");
      await expect(nativeTrip).toContainText(`Chosen-account headroom - ${funded}: EUR 900.00`);
      await expect(nativeTrip).toContainText(`Chosen-account headroom - ${funded}: EUR 800.00`);
      await expect(nativeTrip).not.toContainText("funding shortfall:");
      await expect(page.getByRole("region", { name: "Generated calculator output" })).toHaveCount(0);
    }
    await page.screenshot({ path: testInfo.outputPath("artifact-builtin-only-buffer.png"), fullPage: true });
    const goalArtifact = randomUUID(), goalVersion = randomUUID();
    await db`insert into public.artifacts(id,workspace_id,kind,name,permissions) values(${goalArtifact},${workspace!},'goal_tracker','Synthetic native goals QA','["balances","goals"]'::jsonb)`;
    await db`insert into public.artifact_versions(id,workspace_id,artifact_id,version,source,manifest,status) values(${goalVersion},${workspace!},${goalArtifact},1,'(input) => ({ready:true})','{"kind":"goal_tracker","runtime":"trusted","sdk":[],"params":{},"renderer":"trusted"}'::jsonb,'validated')`;
    await db`update public.artifacts set active_version_id=${goalVersion} where id=${goalArtifact} and workspace_id=${workspace!}`;
    await page.goto(`/ai/library/${goalArtifact}`);
    await expect(page.getByRole("region", { name: "Generated calculator output" })).toHaveCount(0);
    await expect(page.getByText(/Illustrative saving pace is not an affordability result/)).toBeVisible();
    await expect(page.getByText("Recorded savings unknown of EUR 900.00", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "dated account headroom and protections", exact: true })).toHaveAttribute("href", "/plan");
    // Preserve the prior native version and then verify deterministic fallback separately.
    await db`update public.forecast_preferences set spending_account_id=${checking}, safety_buffer_minor=0 where workspace_id=${workspace!}`;
    await db`update public.balance_snapshots set amount_minor=case when account_id=${checking} then 10000 else 100000 end where workspace_id=${workspace!}`;
    await db`update public.financial_assumptions set removed_at=null where workspace_id=${workspace!}`;
    const fallbackVersion = randomUUID();
    await db`insert into public.artifact_versions(id,workspace_id,artifact_id,version,source,manifest,status) values(${fallbackVersion},${workspace!},${artifact},2,${fallback.source},${db.json(JSON.parse(JSON.stringify(fallback.manifest)))},'validated')`;
    await db`update public.artifacts set active_version_id=${fallbackVersion} where id=${artifact} and workspace_id=${workspace!}`;
    await page.goto(`/ai/library/${artifact}`);
    const calculator = page.getByRole("region", { name: "Generated calculator output" });
    await expect(calculator).toContainText("Aggregate headroom: EUR 600.00");
    await expect(calculator).toContainText("Chosen-account headroom"); await expect(calculator).toContainText("-EUR 400.00");
    await expect(calculator).toContainText("funding shortfall: EUR 400.00"); await expect(calculator).toContainText(tomorrow);
    await expect(calculator).toContainText("Recurring bill QA"); await expect(calculator).toContainText("No automatic funding");
    await expect(calculator).toContainText("Chosen-account headroom after dated trip: -50000 minor units.");
    await page.screenshot({ path: testInfo.outputPath("artifact-dated-checking.png"), fullPage: true });
    await db`update public.forecast_preferences set spending_account_id=${savings}, safety_buffer_minor=10000 where workspace_id=${workspace!}`;
    await db`update public.financial_assumptions set removed_at=now() where workspace_id=${workspace!}`;
    await db`update public.balance_snapshots set amount_minor=case when account_id=${savings} then 100000 else 0 end where workspace_id=${workspace!}`;
    await page.reload(); await expect(calculator).toContainText("Workspace buffer: EUR 100.00");
    await expect(calculator).toContainText("Aggregate headroom: EUR 900.00");
    await expect(calculator).toContainText("Chosen-account headroom after dated trip: 80000 minor units.");
    await expect(calculator).not.toContainText("funding shortfall:");
    expect(providerCalls).toEqual([]);
  } finally {
    await context.close().catch(() => {});
    try {
      if (workspace) await db.begin(async tx => {
        await tx`update public.artifacts set active_version_id=null where workspace_id=${workspace!}`;
        for (const table of ["dashboard_items", "artifact_state", "artifact_versions", "artifacts", "insight_dismissals", "goal_reservation_events", "goal_allocations", "goal_events", "goals", "planning_events", "financial_assumptions", "forecast_preference_events", "forecast_preferences", "balance_snapshots", "accounts"]) await tx`delete from ${tx("public." + table)} where workspace_id=${workspace!}`;
        await tx`delete from public.workspaces where id=${workspace!} and owner_id=${user!}`;
      });
      if (user) expect((await admin.auth.admin.deleteUser(user)).error).toBeNull();
      if (workspace) expect((await db`select count(*)::int as count from public.workspaces where id=${workspace}`)[0].count).toBe(0);
      if (user) expect((await admin.auth.admin.getUserById(user)).data.user).toBeNull();
      if (user) {
        writeFileSync(`.qa/mne005-cleanup-${runId}.json`, JSON.stringify({ user, workspace, checking, savings, goal, workspaceRemaining: 0, authUserRemaining: 0, cleaned: true }));
        unlinkSync(recovery);
      }
    } finally { await db.end(); }
  }
});
