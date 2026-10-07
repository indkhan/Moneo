import {test, expect, type BrowserContext} from "@playwright/test";
import {createClient} from "@supabase/supabase-js";
import {createServerClient} from "@supabase/ssr";
import {randomBytes, randomUUID} from "node:crypto";
import {mkdirSync, writeFileSync} from "node:fs";
import postgres from "postgres";
import {loadBalanceEvidence, resolveBalances} from "../lib/finance/balances";
import {evaluatePlanForWorkspace} from "../lib/finance/model";

test.skip(!process.env.SUPABASE_DB_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, "Requires owned synthetic real authentication/database fixtures");

test("dated observations remain visible and explicit booked confirmation reloads and undoes without retyping", async ({browser, baseURL}, info) => {
  test.setTimeout(180_000);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, connection = new URL(process.env.SUPABASE_DB_URL!);
  const project = new URL(url).hostname.split(".")[0], run = randomUUID();
  expect(connection.hostname === `db.${project}.supabase.co` || connection.username.endsWith(`.${project}`)).toBe(true);
  const db = postgres(connection.toString(), {ssl: "require", max: 1, connect_timeout: 10,
    connection: {application_name: "mne012-dated-overview", lock_timeout: 10_000, statement_timeout: 30_000}});
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {auth: {persistSession: false, autoRefreshToken: false}});
  const journal = `.qa/mne012-fixture-${run}.json`, account = randomUUID();
  let user: string | undefined, workspace: string | undefined, context: BrowserContext | undefined;
  let history: {version: string}[] | undefined;
  mkdirSync(".qa", {recursive: true}); writeFileSync(journal, JSON.stringify({run, project, status: "before-create"}));
  try {
    history = await db<{version: string}[]>`select version from supabase_migrations.schema_migrations order by version`;
    expect((await db`select to_regprocedure('public.record_manual_balance(uuid,text,date,boolean,jsonb,uuid,integer,uuid)') present`)[0].present).not.toBeNull();
    const email = `qa-dated-${run}@example.invalid`, password = randomBytes(24).toString("hex");
    const created = await admin.auth.admin.createUser({email, password, email_confirm: true, user_metadata: {qa_test: "mne012", run_id: run}});
    expect(created.error).toBeNull(); user = created.data.user!.id;
    [{id: workspace}] = await db`select id from public.workspaces where owner_id=${user}`;
    writeFileSync(journal, JSON.stringify({run, project, user, workspace, account, status: "created"}));
    const today = new Date().toISOString().slice(0, 10), old = new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10), prior = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    await db.begin(async tx => {
      await tx`insert into public.workspace_settings(workspace_id,timezone,locale,summary_cadence) values(${workspace!},'UTC','en-GB','none') on conflict(workspace_id) do update set timezone='UTC',locale='en-GB',summary_cadence='none'`;
      await tx`insert into public.accounts(id,workspace_id,name,currency_code,type) values(${account},${workspace!},'Dated cash QA','EUR','checking')`;
      await tx`insert into public.balance_snapshots(workspace_id,account_id,amount_minor,currency_code,as_of,provenance) values(${workspace!},${account},10000,'EUR',${old + "T12:00:00Z"},'synthetic imported observation')`;
      await tx`insert into public.transactions(workspace_id,account_id,posted_on,description,amount_minor,currency_code,status) values
        (${workspace!},${account},${prior},'Earlier dated posting',-100,'EUR','posted'),(${workspace!},${account},${today},'Today dated posting',-250,'EUR','posted'),
        (${workspace!},${account},${today},'Synthetic pending hold',-500,'EUR','pending')`;
      await tx`insert into public.wealth_items(id,workspace_id,kind,name,amount_minor,currency_code,as_of) values
        (${randomUUID()},${workspace!},'asset','Historical asset QA',20000,'EUR',${old}),(${randomUUID()},${workspace!},'debt','Historical debt QA',-10000,'EUR',${prior}),(${randomUUID()},${workspace!},'asset','Original yen QA',300,'JPY',${old})`;
    });
    const ledger = async () => db`select id,amount_minor::text,currency_code,posted_on::text,posted_at::text,status,version from public.transactions where workspace_id=${workspace!} order by id`;
    const originalLedger = await ledger();
    const wealth = await db`select id,amount_minor::text,currency_code,as_of::text,version from public.wealth_items where workspace_id=${workspace!} order by id`;
    const cash = async () => {const evidence = await loadBalanceEvidence(admin, workspace!); return resolveBalances(evidence.accounts, evidence.snapshots, evidence.ledger, evidence.asOf, "UTC")[0].balance;};
    expect(await cash()).toMatchObject({status: "stale", amount_minor: null, estimated_amount_minor: "9650"});
    context = await browser.newContext({baseURL});
    const cookies = new Map<string, string>();
    const auth = createServerClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {cookies: {getAll: () => [...cookies].map(([name, value]) => ({name, value})), setAll: values => values.forEach(({name, value}) => cookies.set(name, value))}});
    expect((await auth.auth.signInWithPassword({email, password})).error).toBeNull();
    await context.addCookies([...cookies].map(([name, value]) => ({name, value, domain: "localhost", path: "/", sameSite: "Lax" as const})));
    const page = await context.newPage(), modelRequests: string[] = [];
    page.on("request", request => {if (/openrouter|\/api\/chat|\/api\/analysis/.test(request.url())) modelRequests.push(request.url());});
    page.setDefaultTimeout(30_000);
    console.log('MNE012 step: opening Home');
    await page.goto("/", {waitUntil: 'domcontentloaded'});
    console.log('MNE012 step: dated observations');
    const dated = page.locator("details").filter({has: page.locator("summary").filter({hasText: /^Recorded net worth by currency$/})});
    await dated.locator("summary").click();
    await expect(dated).toContainText("EUR 200.00"); await expect(dated).toContainText("JPY 300");
    await expect(dated).toContainText("Historical debt QA"); await expect(dated).toContainText("synthetic imported observation");
    await expect(dated).toContainText("not verified current funds"); await expect(dated).toContainText(old);
    const card = page.locator("article").filter({has: page.getByRole("heading", {name: "Dated cash QA", exact: true})});
    await card.getByText("Confirm recorded balance", {exact: true}).click();
    await expect(card).toContainText("EUR 96.50"); await expect(card).toContainText("Earlier dated posting");
    const confirmation = card.getByRole("checkbox", {name: /I checked my bank/});
    await expect(confirmation).not.toBeChecked();
    await confirmation.check();
    console.log('MNE012 step: confirming booked balance');
    await card.getByRole("button", {name: "Confirm balance without retyping", exact: true}).click();
    await expect(async () => {await page.reload(); expect(await cash()).toMatchObject({status: "current", amount_minor: "9650"});}).toPass({timeout: 30_000});
    const [saved] = await db`select amount_minor::text,boundary_kind,covered_transactions,actor_id from public.balance_snapshots where account_id=${account} order by created_at desc,id desc`;
    expect(saved).toMatchObject({amount_minor: "9650", boundary_kind: "reviewed_activity", actor_id: user}); expect(saved.covered_transactions).toHaveLength(1);
    const plan = await evaluatePlanForWorkspace(admin, {id: workspace!, display_currency: "EUR", timezone: "UTC"}, 30);
    expect(plan.input.missingInputs?.some(input => input.includes("principal valuation is historical"))).toBe(true);
    await card.getByText("Manual balance history and undo", {exact: true}).click();
    await card.getByRole("button", {name: "Undo balance", exact: true}).click();
    console.log('MNE012 step: Undo submitted');
    await expect(async () => {await page.reload(); expect(await cash()).toMatchObject({status: "stale", amount_minor: null, estimated_amount_minor: "9650"});}).toPass({timeout: 30_000});
    expect((await db`select count(*)::int count from public.balance_snapshots where account_id=${account} and undone_at is not null`)[0].count).toBe(1);
    expect(await ledger()).toEqual(originalLedger);
    expect(await db`select id,amount_minor::text,currency_code,as_of::text,version from public.wealth_items where workspace_id=${workspace!} order by id`).toEqual(wealth);
    expect(modelRequests).toEqual([]);
    await page.screenshot({path: info.outputPath("dated-observations-confirmation-undo.png"), fullPage: true});
  } finally {
    try {
      await context?.close().catch(() => {});
      if (user) {const owned = await admin.auth.admin.getUserById(user); expect(owned.error).toBeNull(); expect(owned.data.user?.user_metadata).toMatchObject({qa_test: "mne012", run_id: run});}
      const tables = ["wealth_events", "wealth_items", "balance_snapshots", "transactions", "accounts", "workspace_settings"];
      if (workspace) await db.begin(async tx => {
        expect((await tx`select owner_id from public.workspaces where id=${workspace!}`)[0]?.owner_id).toBe(user);
        for (const table of tables) await tx`delete from ${tx("public." + table)} where workspace_id=${workspace!}`;
        await tx`delete from public.workspaces where id=${workspace!} and owner_id=${user!}`;
      });
      if (user) {expect((await admin.auth.admin.deleteUser(user)).error).toBeNull(); expect((await db`select id from auth.users where id=${user}`).length).toBe(0);}
      if (workspace) {expect((await db`select id from public.workspaces where id=${workspace}`).length).toBe(0); for (const table of tables) expect((await db`select count(*)::int count from ${db("public." + table)} where workspace_id=${workspace}`)[0].count).toBe(0);}
      if (history) expect(await db`select version from supabase_migrations.schema_migrations order by version`).toEqual(history);
      writeFileSync(journal, JSON.stringify({run, project, user, workspace, status: "cleaned", exactCleanupZero: true, migrationLedgerUnchanged: true}));
    } finally {await db.end();}
  }
});
