import { test, expect, type BrowserContext } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import postgres from "postgres";
import { FALLBACK_CALCULATORS } from "../lib/artifacts/templates";
import { addTripDays, defaultTripScenario } from "../lib/finance/trip-scenario";

test.skip(!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.SUPABASE_DB_URL || !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, "Requires disposable synthetic Supabase authentication/database fixtures");

test("dated native budgets and unsaved calculator inputs agree without financial mutations or model calls", async ({ browser, baseURL }, testInfo) => {
  test.setTimeout(240_000);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, project = new URL(url).hostname.split(".")[0];
  const connection = new URL(process.env.SUPABASE_DB_URL!);
  expect(connection.hostname === `db.${project}.supabase.co` || connection.username.endsWith(`.${project}`)).toBeTruthy();
  const db = postgres(connection.toString(), { ssl: "require", max: 1 });
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const runId = randomUUID(), journal = `.qa/mne031-fixture-${runId}.json`;
  let user: string | undefined, workspace: string | undefined, context: BrowserContext | undefined;
  const checking = randomUUID(), savings = randomUUID(), artifact = randomUUID(), version = randomUUID();
  mkdirSync(".qa", { recursive: true }); writeFileSync(journal, JSON.stringify({ runId, status: "before-create" }));
  const migrationLedger = await db`select version from supabase_migrations.schema_migrations order by version`;
  try {
    const email = `qa-trip-${runId}@example.invalid`, password = randomBytes(24).toString("hex");
    const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { qa_test: "mne031", run_id: runId } });
    expect(created.error).toBeNull(); user = created.data.user!.id;
    [{ id: workspace }] = await db`select id from public.workspaces where owner_id=${user}`;
    const assertOwner = async () => {
      const owned = await admin.auth.admin.getUserById(user!);
      expect(owned.error).toBeNull();
      expect(owned.data.user?.user_metadata).toMatchObject({ qa_test: "mne031", run_id: runId });
      expect((await db`select owner_id from public.workspaces where id=${workspace!}`)[0]?.owner_id).toBe(user);
    };
    await assertOwner();
    writeFileSync(journal, JSON.stringify({ user, workspace, checking, savings, artifact, version, status: "created" }));
    const now = new Date().toISOString(), today = now.slice(0, 10), tomorrow = addTripDays(today, 1), salaryDate = addTripDays(today, 2), tripDate = addTripDays(today, 7), hotelDate = addTripDays(today, 10);
    const scenario = defaultTripScenario(today, "EUR", checking, 20000n);
    await db.begin(async tx => {
      await tx`insert into public.workspace_settings(workspace_id,timezone,locale,ai_data_scopes,summary_cadence) values(${workspace!},'UTC','en-GB',ARRAY['accounts','transactions','planning','imports']::text[],'none') on conflict(workspace_id) do update set timezone='UTC',locale='en-GB',ai_data_scopes=ARRAY['accounts','transactions','planning','imports']::text[],summary_cadence='none'`;
      await tx`insert into public.accounts(id,workspace_id,name,currency_code,type) values(${checking},${workspace!},'Trip checking QA','EUR','checking'),(${savings},${workspace!},'Trip savings QA','EUR','savings')`;
      for (const account of [checking, savings]) await tx`insert into public.balance_snapshots(workspace_id,account_id,amount_minor,currency_code,as_of,provenance,boundary_kind,covered_transactions,actor_id) values(${workspace!},${account},10000,'EUR',${now},'synthetic trip opening','reviewed_activity','[]'::jsonb,${user!})`;
      await tx`insert into public.financial_assumptions(workspace_id,account_id,kind,name,amount_minor,currency_code,cadence,starts_on,source,confirmed,enabled) values(${workspace!},${checking},'income','Synthetic salary before trip',100000,'EUR','once',${salaryDate},'manual',true,true)`;
      await tx`insert into public.forecast_preferences(workspace_id,currency_code,uncertainty_bps,spending_account_id) values(${workspace!},'EUR',0,${checking})`;
      await tx`insert into public.artifacts(id,workspace_id,kind,name,permissions) values(${artifact},${workspace!},'trip_planner','Synthetic dated trip QA','["forecast","balances"]'::jsonb)`;
      await tx`insert into public.artifact_versions(id,workspace_id,artifact_id,version,source,manifest,status) values(${version},${workspace!},${artifact},1,'input => ({ready:true})','{"kind":"trip_planner","runtime":"trusted"}'::jsonb,'validated')`;
      await tx`update public.artifacts set active_version_id=${version} where id=${artifact} and workspace_id=${workspace!}`;
      await tx`insert into public.artifact_state(artifact_id,workspace_id,state) values(${artifact},${workspace!},${tx.json({ costMinor: 20000, tripScenario: scenario })})`;
    });
    const fingerprint = async () => (await db`select md5(jsonb_build_object(
      'balances',(select jsonb_agg(to_jsonb(b) order by id) from public.balance_snapshots b where workspace_id=${workspace!}),
      'transactions',(select jsonb_agg(to_jsonb(t) order by id) from public.transactions t where workspace_id=${workspace!}),
      'assumptions',(select jsonb_agg(to_jsonb(a) order by id) from public.financial_assumptions a where workspace_id=${workspace!}),
      'allocations',(select jsonb_agg(to_jsonb(g) order by id) from public.goal_allocations g where workspace_id=${workspace!}),
      'scenarios',(select jsonb_agg(to_jsonb(s) order by id) from public.scenario_overrides s where workspace_id=${workspace!}),
      'planningHistory',(select jsonb_agg(to_jsonb(p) order by id) from public.planning_events p where workspace_id=${workspace!})
    )::text) digest`)[0].digest;
    const financialBefore = await fingerprint();
    const cookies = new Map<string, string>();
    const auth = createServerClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { cookies: { getAll: () => [...cookies].map(([name,value]) => ({name,value})), setAll: values => values.forEach(({name,value}) => cookies.set(name,value)) } });
    expect((await auth.auth.signInWithPassword({ email, password })).error).toBeNull();
    context = await browser.newContext({ baseURL });
    await context.addCookies([...cookies].map(([name,value]) => ({ name,value,domain: new URL(baseURL!).hostname,path: "/",sameSite: "Lax" as const })));
    const modelRequests: string[] = [];
    await context.route(/\/api\/chat|\/api\/artifacts\/.*generate|openrouter\.ai/, route => { modelRequests.push(route.request().url()); return route.abort(); });
    const page = await context.newPage(); page.setDefaultTimeout(20_000);
    const readState = async () => (await db`select state,version from public.artifact_state where artifact_id=${artifact} and workspace_id=${workspace!}`)[0];
    await page.goto(`/ai/library/${artifact}`);
    const native = page.locator("section").filter({ has: page.getByRole("heading", { name: "Dated trip planner", exact: true }) });
    const results = native.getByLabel("Dated trip results");
    const amount = native.getByLabel("Amount in minor units", { exact: false }).first();
    await expect(results).toContainText(`Forecast horizon: ${today} to ${addTripDays(today, 28)} (29 days)`);
    await expect(results).toContainText(`Limited on ${today}`);
    await expect(results.getByRole("heading", { name: "With-trip minimum headroom" }).locator("..")).toContainText("EUR 100.00");
    await expect(results.getByRole("heading", { name: "End-of-trip headroom" }).locator("..")).toContainText("EUR 900.00");
    await expect(native.getByLabel("Paying / receiving account").first()).toHaveValue(checking);
    await amount.fill("30000");
    await expect(results.getByRole("heading", { name: "End-of-trip headroom" }).locator("..")).toContainText("EUR 800.00");
    expect((await readState()).state.costMinor).toBe(20000);
    await native.getByRole("button", { name: "Undo local changes" }).click(); await expect(amount).toHaveValue("20000");
    // A payment before salary produces a real dated funding gap despite positive later funds.
    await native.getByLabel("Payment date").first().fill(tomorrow);
    await expect(results.getByRole("heading", { name: "With-trip minimum headroom" }).locator("..")).toContainText("-EUR 100.00");
    await expect(results).toContainText(`Limited on ${tomorrow}`);
    await native.getByRole("button", { name: "Undo local changes" }).click();
    await native.getByRole("button", { name: "Add payment" }).click();
    const hotel = native.getByRole("group", { name: "Payment 2", exact: true });
    await hotel.getByLabel("Name", { exact: true }).fill("Synthetic hotel");
    await hotel.getByLabel("Payment date").fill(hotelDate);
    await hotel.getByLabel("Amount in minor units").fill("40000");
    await hotel.getByLabel("Paying / receiving account").selectOption(savings);
    await hotel.getByLabel("Currency", { exact: true }).fill("USD");
    await expect(results).toContainText("rate:USD->EUR");
    await hotel.getByLabel("Rate", { exact: true }).fill("0.5");
    await hotel.getByLabel("Rate date", { exact: true }).fill(today);
    await hotel.getByLabel("Rate source", { exact: true }).fill("Synthetic manual trip assumption");
    await expect(results).toContainText("Budget costs EUR 400.00");
    await expect(results).toContainText(`${savings} funding shortfall: EUR 100.00`);
    await expect(results).toContainText(hotelDate);
    await native.getByRole("button", { name: "Add payment" }).click();
    const contribution = native.getByRole("group", { name: "Payment 3", exact: true });
    await contribution.getByLabel("Type").selectOption("contribution");
    await contribution.getByLabel("Name", { exact: true }).fill("Synthetic external contribution");
    await contribution.getByLabel("Amount in minor units").fill("10000");
    await expect(results).toContainText("external contributions EUR 100.00 · net cost EUR 300.00");
    await native.getByRole("button", { name: "Save scenario", exact: true }).click();
    await expect(native).toContainText("Inputs saved.");
    expect((await readState()).state.costMinor).toBe(40000);
    await page.reload();
    await expect(native.getByRole("group", { name: "Payment 2", exact: true }).getByLabel("Rate source")).toHaveValue("Synthetic manual trip assumption");
    expect((await readState()).state.tripScenario.payments).toHaveLength(3);
    await page.screenshot({ path: testInfo.outputPath("native-dated-budget.png"), fullPage: true });
    await native.getByRole("group", { name: "Payment 3", exact: true }).getByRole("button", { name: "Remove payment" }).click();
    await native.getByRole("group", { name: "Payment 2", exact: true }).getByRole("button", { name: "Remove payment" }).click();
    await native.getByRole("button", { name: "Save scenario", exact: true }).click();
    await expect(native).toContainText("Inputs saved.");
    const versions = await (await page.request.get(`/api/artifacts/${artifact}/versions`)).json();
    const fallback = FALLBACK_CALCULATORS.trip_planner;
    const installed = await page.request.post(`/api/artifacts/${artifact}/versions`, { data: { source: fallback.source, expectedActiveVersionId: versions.activeVersionId,
      manifest: { ...fallback.manifest, params: { costMinor: { type: "number", default: 20000, min: 0, max: 10000000, label: "Trip cost" }, tripDate: { type: "string", default: tripDate, maxLength: 10, label: "Trip date" }, accountId: { type: "string", default: checking, maxLength: 100, label: "Paying account ID" } } } } });
    expect(installed.ok(), await installed.text()).toBe(true);
    await page.reload();
    const panel = page.getByRole("region", { name: "Generated calculator output" });
    const print = panel.getByRole("button", { name: "Print / PDF", exact: true });
    await expect(panel).toContainText("Conservative minimum headroom over the dated trip horizon: 10000 minor units");
    await expect(print).toBeEnabled();
    await panel.getByLabel("Trip cost", { exact: false }).fill("120000");
    await expect(print).toBeDisabled();
    await expect(panel).toContainText("Conservative minimum headroom over the dated trip horizon: -10000 minor units");
    await expect(print).toBeEnabled();
    expect((await readState()).state.costMinor).toBe(20000);
    await page.evaluate(() => { const append = document.body.append.bind(document.body); document.body.append = (...nodes) => { append(...nodes); for (const node of nodes) if (node instanceof HTMLIFrameElement && node.contentWindow) node.contentWindow.print = () => {}; }; });
    await print.click();
    const printed = await page.locator('iframe[title="Printable calculator report"]').contentFrame().locator("pre").innerText();
    expect(printed).toContain('"costMinor": 120000'); expect(printed).toContain('"withTripAvailableMinor": "-10000"'); expect(printed).toContain("Evidence revision:"); expect(printed).toContain('"horizon"');
    await panel.getByLabel("Trip cost", { exact: false }).fill("20000");
    await expect(panel).toContainText("Conservative minimum headroom over the dated trip horizon: 10000 minor units");
    await panel.getByLabel("Paying account ID", { exact: true }).fill(savings);
    await expect(panel).toContainText("Conservative minimum headroom over the dated trip horizon: -10000 minor units");
    await panel.getByLabel("Paying account ID", { exact: true }).fill(checking);
    await expect(panel).toContainText("Conservative minimum headroom over the dated trip horizon: 10000 minor units");
    await panel.getByLabel("Trip date", { exact: true }).fill(tomorrow);
    await expect(panel).toContainText("Conservative minimum headroom over the dated trip horizon: -10000 minor units");
    await expect(panel).toContainText(`limited on ${tomorrow}`);
    await panel.getByRole("button", { name: "Save inputs", exact: true }).click(); await expect(panel).toContainText("Inputs saved.");
    await page.reload();
    await expect(native.getByLabel("Trip start")).toHaveValue(tomorrow);
    await expect(native.getByLabel("Payment date").first()).toHaveValue(tomorrow);
    await expect(results.getByRole("heading", { name: "With-trip minimum headroom" }).locator("..")).toContainText("-EUR 100.00");
    await expect(panel).toContainText("Conservative minimum headroom over the dated trip horizon: -10000 minor units");
    await expect(print).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("calculator-unsaved-and-persisted.png"), fullPage: true });

    // Generated Save has persisted scalar date/account inputs. Native Save must replace them.
    await native.getByLabel("Trip start").fill(tripDate);
    await native.getByLabel("Trip end").fill(tripDate);
    await native.getByLabel("Payment date").first().fill(tripDate);
    await native.getByLabel("Paying / receiving account").first().selectOption(savings);
    await amount.fill("2000");
    await expect(results.getByRole("heading", { name: "With-trip minimum headroom" }).locator("..")).toContainText("EUR 80.00");
    await native.getByRole("button", { name: "Save scenario", exact: true }).click();
    await expect(native).toContainText("Inputs saved.");
    expect((await readState()).state).toMatchObject({ costMinor: 2000, tripDate, accountId: savings });
    await page.reload();
    await expect(panel.getByLabel("Trip date", { exact: true })).toHaveValue(tripDate);
    await expect(panel.getByLabel("Paying account ID", { exact: true })).toHaveValue(savings);
    await expect(panel).toContainText("Conservative minimum headroom over the dated trip horizon: 8000 minor units");
    await expect(panel).not.toContainText("Recalculate the dated trip inputs");
    await expect(print).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("native-save-after-generated-save.png"), fullPage: true });

    // A cost-only generated version must also use the saved native date and paying account.
    let activeVersionId = (await (await page.request.get(`/api/artifacts/${artifact}/versions`)).json()).activeVersionId;
    const costOnly = await page.request.post(`/api/artifacts/${artifact}/versions`, { data: { source: fallback.source, expectedActiveVersionId: activeVersionId, manifest: fallback.manifest } });
    expect(costOnly.ok(), await costOnly.text()).toBe(true);
    await page.reload();
    await expect(panel).toContainText("Conservative minimum headroom over the dated trip horizon: 8000 minor units");
    await expect(panel).toContainText(`Chosen-account headroom - ${savings}`);

    // New calculator first load: defaults have no saved scenario and differ from host defaults.
    for (const explicitAccount of [true, false]) {
      await assertOwner();
      await db`update public.artifact_state set state='{}'::jsonb,version=version+1 where artifact_id=${artifact} and workspace_id=${workspace!}`;
      activeVersionId = (await (await page.request.get(`/api/artifacts/${artifact}/versions`)).json()).activeVersionId;
      const defaults = await page.request.post(`/api/artifacts/${artifact}/versions`, { data: { source: fallback.source, expectedActiveVersionId: activeVersionId,
        manifest: { ...fallback.manifest, params: { costMinor: { type: "number", default: 20000, min: 0, max: 10000000, label: "Trip cost" }, tripDate: { type: "string", default: hotelDate, maxLength: 10, label: "Trip date" }, ...(explicitAccount ? { accountId: { type: "string", default: savings, maxLength: 100, label: "Paying account ID" } } : {}) } } } });
      expect(defaults.ok(), await defaults.text()).toBe(true);
      await page.reload();
      await expect(panel.getByLabel("Trip date", { exact: true })).toHaveValue(hotelDate);
      if (explicitAccount) await expect(panel.getByLabel("Paying account ID", { exact: true })).toHaveValue(savings);
      await expect(panel).toContainText(`Conservative minimum headroom over the dated trip horizon: ${explicitAccount ? "-10000" : "10000"} minor units`);
      await expect(panel).toContainText(`Chosen-account headroom - ${explicitAccount ? savings : checking}`);
      await expect(panel).toContainText(addTripDays(hotelDate, 21));
      await expect(print).toBeEnabled();
      await page.screenshot({ path: testInfo.outputPath(`manifest-default-${explicitAccount ? "date-account" : "date-only"}.png`), fullPage: true });
      expect((await readState()).state).toEqual({});
    }
    expect(await fingerprint()).toBe(financialBefore);
    expect(modelRequests).toEqual([]);
  } finally {
    await context?.close().catch(() => {});
    if (user) {
      const owned = await admin.auth.admin.getUserById(user);
      expect(owned.error).toBeNull();
      expect(owned.data.user?.user_metadata).toMatchObject({ qa_test: "mne031", run_id: runId });
    }
    if (workspace) await db.begin(async tx => {
      expect((await tx`select owner_id from public.workspaces where id=${workspace!}`)[0]?.owner_id).toBe(user);
      await tx`update public.artifacts set active_version_id=null where workspace_id=${workspace!}`;
      for (const table of ["dashboard_items", "artifact_state", "artifact_versions", "artifacts", "planning_events", "financial_assumptions", "forecast_preference_events", "forecast_preferences", "balance_snapshots", "accounts", "workspace_settings"]) await tx`delete from ${tx("public." + table)} where workspace_id=${workspace!}`;
      await tx`delete from public.workspaces where id=${workspace!} and owner_id=${user!}`;
    });
    if (user) { expect((await admin.auth.admin.deleteUser(user)).error).toBeNull(); expect((await db`select id from auth.users where id=${user}`).length).toBe(0); }
    if (workspace) {
      expect((await db`select id from public.workspaces where id=${workspace}`).length).toBe(0);
      for (const table of ["artifact_state", "artifact_versions", "artifacts", "financial_assumptions", "balance_snapshots", "accounts"]) expect((await db`select count(*)::int remaining from ${db("public." + table)} where workspace_id=${workspace}`)[0].remaining).toBe(0);
    }
    expect(await db`select version from supabase_migrations.schema_migrations order by version`).toEqual(migrationLedger);
    writeFileSync(journal, JSON.stringify({ user, workspace, status: "cleaned", exactCleanupZero: true, migrationLedgerUnchanged: true }));
    await db.end();
  }
});
