import {test, expect as baseExpect} from "@playwright/test";
const expect = baseExpect.configure({ timeout: 30_000 });
import {createClient} from "@supabase/supabase-js";
import {createServerClient} from "@supabase/ssr";
import {randomBytes, randomUUID} from "node:crypto";
import {appendFileSync, mkdirSync} from "node:fs";
import postgres from "postgres";
import {recurringFixtureCalendar} from "./recurring-calendar";

const configured = process.env.SUPABASE_DB_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
test.skip(!configured, "Requires root release, disposable real auth and deployed reviewed MNE014 migration 017; a skip is not acceptance");

for (const cadence of ["weekly", "biweekly", "monthly", "quarterly", "yearly"] as const) {
  test(`${cadence}: owned confirm/decline, calendar forecast, occurrence undo and source correction`, async ({browser}) => {
    test.setTimeout(240_000);
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!, connection = new URL(process.env.SUPABASE_DB_URL!);
    const project = new URL(url).hostname.split(".")[0];
    expect(connection.hostname === `db.${project}.supabase.co` || connection.username.endsWith(`.${project}`)).toBe(true);
    const db = postgres(connection.toString(), {ssl: "require", max: 1, connect_timeout: 10, connection: {application_name: "MNE014-browser-coverage", lock_timeout: 10_000, statement_timeout: 120_000, idle_in_transaction_session_timeout: 150_000}});
    const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!, {auth: {persistSession: false, autoRefreshToken: false}});
    const context = await browser.newContext({baseURL: "http://localhost:3000"});
    let user: string | undefined, workspace: string | undefined;
    const runId = randomUUID();
    mkdirSync(".qa", {recursive: true});
    const journal = `.qa/mne014-browser-${runId}.jsonl`;
    const record = (phase: string, fields: Record<string, unknown> = {}) => appendFileSync(journal, JSON.stringify({task: "MNE014", runId, project, cadence, user, workspace, phase, ...fields}) + "\n");
    record("prepared");
    let migrationLedger: unknown;
    try {
      migrationLedger = await db`select version,name,statements from supabase_migrations.schema_migrations order by version`;
      expect((await db`select 1 from information_schema.columns where table_schema='public' and table_name='financial_assumptions' and column_name in ('schedule_anchor_on','recurring_evidence_eligible')`).length, "Root must deploy reviewed 017 before this browser gate").toBe(2);
      const email = `mne014-${runId}@example.invalid`, password = randomBytes(24).toString("hex");
      const created = await admin.auth.admin.createUser({email, password, email_confirm: true, user_metadata: {qa_test: "MNE014", run_id: runId}});
      expect(created.error).toBeNull(); user = created.data.user!.id; record("auth_created");
      [{id: workspace}] = await db`select id from public.workspaces where owner_id=${user}`; record("workspace_owned");
      const account = randomUUID(), counterpart = randomUUID(), merchant = randomUUID(), ids = [randomUUID(), randomUUID(), randomUUID()], credit = randomUUID();
      const label = `MNE014 ${cadence} ${runId.slice(0, 8)}`, creditLabel = `${label} counterpart`;
      const [{today: clockDate}] = await db`select (now() at time zone 'UTC')::date::text as today`;
      const {today,anchor,dates,latest,postedLatest,next,months,days:stepDays}=recurringFixtureCalendar(clockDate,cadence,true);
      const [{future_count:futureCount}]=await db`
        select (select count(*)::int from generate_series(1,60) n where
          (case when ${months}>0 then ${anchor}::date+make_interval(months=>${months}*n) else ${anchor}::date+${stepDays}*n end)::date>=${today}::date and
          (case when ${months}>0 then ${anchor}::date+make_interval(months=>${months}*n) else ${anchor}::date+${stepDays}*n end)::date<${today}::date+365) as future_count`;
      await db.begin(async tx => {
        await tx`insert into public.workspace_settings(workspace_id,timezone,locale,summary_cadence) values(${workspace!},'UTC','en-US','none')`;
        await tx`insert into public.accounts(id,workspace_id,name,currency_code,type) values(${account},${workspace!},${label},'EUR','checking'),(${counterpart},${workspace!},${creditLabel},'EUR','checking')`;
        await tx`insert into public.merchants(id,workspace_id,name,normalized_name) values(${merchant},${workspace!},${label},${label.toLowerCase()})`;
        for (const [index, id] of ids.entries()) {
          await tx`insert into public.transactions(id,workspace_id,account_id,posted_on,description,amount_minor,currency_code,status,kind,merchant_id)
            values(${id},${workspace!},${account},${index===2 ? postedLatest : dates[index]}::date,${label + " invoice " + index},-2000,'EUR','posted','ordinary',${merchant})`;
        }
        await tx`insert into public.transactions(id,workspace_id,account_id,posted_on,description,amount_minor,currency_code,status,kind) values(${credit},${workspace!},${counterpart},${postedLatest},${creditLabel},2000,'EUR','posted','ordinary')`;
        for (const [id, balance] of [[account, "200000"], [counterpart, "0"]]) {
          const covered = await tx`select id,version,amount_minor::text,currency_code,posted_on::text,posted_at from public.transactions where workspace_id=${workspace!} and account_id=${id}`;
          await tx`insert into public.balance_snapshots(workspace_id,account_id,amount_minor,currency_code,as_of,provenance,boundary_kind,covered_transactions,actor_id)
            values(${workspace!},${id},${balance},'EUR',now(),'MNE014 synthetic reviewed opening','reviewed_activity',${tx.json(covered)},${user!})`;
        }
        await tx`insert into public.forecast_preferences(workspace_id,currency_code,uncertainty_bps) values(${workspace!},'EUR',0)`;
      });
      record("synthetic_seeded", {account, counterpart, merchant, transactionIds: [...ids, credit], next});
      const original = await db`select id,posted_on::text,description,amount_minor::text,currency_code,merchant_id from public.transactions where workspace_id=${workspace!} order by id`;
      const cookies = new Map<string,string>();
      const auth = createServerClient(url, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {cookies: {getAll: () => [...cookies].map(([name,value]) => ({name,value})), setAll: values => values.forEach(({name,value}) => cookies.set(name,value))}});
      expect((await auth.auth.signInWithPassword({email,password})).error).toBeNull();
      await context.addCookies([...cookies].map(([name,value]) => ({name,value,domain: "localhost",path: "/",sameSite: "Lax" as const})));
      const page = await context.newPage(); page.setDefaultTimeout(30_000);
      let aiRequests = 0;
      await page.route(/\/api\/(chat|analysis|ai)(\/|\?|$)/, async route => {aiRequests++; await route.abort();});
      const reviewBookedBalances = async () => {
        await page.goto("/");
        for (const [name, accountId, decimal, minor] of [[label,account,"2000.00","200000"],[creditLabel,counterpart,"0.00","0"]]) {
          const card=page.locator("article").filter({has:page.getByRole("heading",{name,exact:true})});
          const form=card.locator("form").filter({has:page.getByLabel(`${name} balance`,{exact:true})});
          const requestId=await form.locator('input[name="requestId"]').inputValue();
          const coveredTransactions=JSON.parse(await form.locator('input[name="coveredTransactions"]').inputValue());
          await form.getByLabel(`${name} balance`,{exact:true}).fill(decimal);
          await form.locator("summary").click();
          await form.getByRole("checkbox",{name:/I checked today's booked balance/}).check();
          await form.getByRole("button",{name:"Save",exact:true}).click();
          await expect(async () => {
            const [saved]=await db`select id,amount_minor::text,boundary_kind,actor_id,covered_transactions from public.balance_snapshots where workspace_id=${workspace!} and account_id=${accountId} order by created_at desc,id desc limit 1`;
            expect(saved).toMatchObject({id:requestId,amount_minor:minor,boundary_kind:"reviewed_activity",actor_id:user,covered_transactions:coveredTransactions});
          }).toPass({timeout:30_000});
          // Wait for the action's refreshed forms before editing the next account.
          await expect(form.locator('input[name="expectedSnapshotId"]')).toHaveValue(requestId);
        }
        record("booked_balances_reviewed",{amountsMinor:["200000","0"]});
      };
      const candidate = page.locator("article").filter({hasText: `${label} invoice`});
      const forecast = page.locator("section").filter({has: page.getByRole("heading", {name: "Liquid balance horizon",exact: true})});
      expect(latest > today).toBe(true); expect(postedLatest).toBe(today); expect(futureCount).toBeGreaterThan(0);
      const expected = `EUR ${(2000 - (futureCount-1) * 20).toFixed(2)}`;
      await page.goto("/money/recurring");
      await expect(candidate).toHaveCount(1); await expect(candidate).toContainText(cadence);
      await expect(candidate).toContainText("3 observed payments");
      await expect(candidate).toContainText("not a probability");
      await candidate.getByRole("button", {name: "Confirm",exact: true}).click(); await expect(candidate).toContainText("Confirmed");
      const [generated] = await db`select a.id,a.version,a.cadence,a.schedule_anchor_on::text from public.financial_assumptions a join public.recurring_series s on s.assumption_id=a.id where s.workspace_id=${workspace!} and s.account_id=${account}`;
      expect(generated.cadence).toBe(cadence); expect(generated.schedule_anchor_on).toBe(anchor);
      await page.goto("/plan?horizon=365"); await expect(forecast).toContainText(expected); await expect(forecast).not.toContainText("Forecast unavailable");
      await page.goto("/money/recurring"); await candidate.getByRole("button", {name: "Not recurring",exact: true}).click(); await expect(candidate).toContainText("Dismissed");
      await page.goto("/plan?horizon=365"); await expect(forecast).toContainText("EUR 2000.00");
      await page.goto("/money/recurring"); await candidate.getByRole("button", {name: "Confirm",exact: true}).click(); await expect(candidate).toContainText("Confirmed");
      const review = page.getByRole("region", {name: "Occurrence reconciliation"});
      const [{version}] = await db`select version from public.financial_assumptions where id=${generated.id} and workspace_id=${workspace!}`;
      await review.getByRole("combobox", {name: "Confirmed assumption",exact: true}).selectOption(`${generated.id}:${version}`);
      await review.getByLabel("Scheduled occurrence date", {exact: true}).fill(latest);
      await review.getByRole("combobox", {name: "Transaction",exact: true}).selectOption(`${ids[2]}:0`);
      await review.getByRole("combobox", {name: "Fulfillment",exact: true}).selectOption("full");
      await review.getByRole("button", {name: "Associate occurrence",exact: true}).click(); await expect(review).toContainText("recorded full settlement");
      await page.goto("/plan?horizon=365"); await expect(forecast).toContainText(expected);
      await page.goto("/money/recurring"); await review.getByRole("button", {name: "Undo occurrence association",exact: true}).click(); await expect(review).toContainText("undone");
      await page.goto("/plan?horizon=365"); await expect(forecast).toContainText(expected);
      await page.goto(`/money/transactions?transaction=${ids[2]}&linkSearch=${encodeURIComponent(creditLabel)}`);
      const detail = page.getByRole("complementary", {name: "Transaction details"});
      const transfer = detail.locator("form").filter({has: page.getByRole("heading", {name: "Verified transfer",exact: true})});
      const choices = transfer.getByRole("combobox", {name: "Transfer counterpart",exact: true});
      await choices.selectOption((await choices.locator("option").filter({hasText: creditLabel}).getAttribute("value"))!);
      await transfer.getByRole("checkbox").check(); await transfer.getByRole("button", {name: "Confirm verified transfer",exact: true}).click();
      await expect(detail.getByText("Transfer pair:", {exact: false})).toBeVisible();
      await page.goto("/money/recurring"); await expect(page.getByRole("heading", {name: "Confirmed source evidence changed",exact: true})).toBeVisible();
      await page.goto("/plan?horizon=365"); await expect(forecast).toContainText("Forecast unavailable");
      await reviewBookedBalances();
      await page.goto("/plan?horizon=365"); await expect(forecast).toContainText("EUR 2000.00");
      await page.goto(`/money/transactions?transaction=${ids[2]}`); await detail.getByRole("button", {name: "Undo verified link",exact: true}).click();
      await expect(detail.getByRole("heading", {name: "Verified transfer",exact: true})).toBeVisible();
      await page.goto("/money/recurring"); await expect(candidate).toContainText("Confirmed");
      await reviewBookedBalances();
      await page.goto("/plan?horizon=365"); await expect(forecast).toContainText(expected);
      // Paid today for a future slot: provenance-only Plan toggles must not pay it twice.
      const schedule=page.locator("li").filter({has:page.getByRole("heading",{name:`${label} invoice 0`,exact:true})});
      await schedule.getByRole("button",{name:"Disable",exact:true}).click();
      await expect(forecast).toContainText("EUR 2000.00");
      const disabledSchedule=page.locator("li").filter({has:page.getByRole("heading",{name:`${label} invoice 0 (disabled)`,exact:true})});
      await disabledSchedule.getByRole("button",{name:"Enable",exact:true}).click();
      await expect(schedule.getByRole("button",{name:"Disable",exact:true})).toBeVisible();
      await expect(disabledSchedule).toHaveCount(0);
      await page.goto("/plan?horizon=365");
      await expect(forecast).toContainText(expected);
      const [toggled]=await db`select source,recurring_evidence_eligible,starts_on::text,schedule_anchor_on::text from public.financial_assumptions where id=${generated.id} and workspace_id=${workspace!}`;
      expect(toggled).toMatchObject({source:"user",recurring_evidence_eligible:true,starts_on:latest,schedule_anchor_on:anchor});
      record("early_payment_toggle_verified",{scheduledOn:latest,postedOn:postedLatest});
      // Dismiss candidate discovery while retaining this intentional schedule's paid proof.
      await page.goto("/money/recurring");
      await candidate.getByRole("button",{name:"Not recurring",exact:true}).click();
      await expect(candidate).toContainText("Dismissed");
      await page.goto("/plan?horizon=365"); await expect(forecast).toContainText(expected);
      await page.goto(`/money/transactions?transaction=${ids[2]}&linkSearch=${encodeURIComponent(creditLabel)}`);
      await choices.selectOption((await choices.locator("option").filter({hasText:creditLabel}).getAttribute("value"))!);
      await transfer.getByRole("checkbox").check(); await transfer.getByRole("button",{name:"Confirm verified transfer",exact:true}).click();
      await expect(detail.getByText("Transfer pair:",{exact:false})).toBeVisible();
      const [invalidated]=await db`select status,evidence_invalidated from public.recurring_series where assumption_id=${generated.id} and workspace_id=${workspace!}`;
      expect(invalidated).toMatchObject({status:"dismissed",evidence_invalidated:true});
      await page.goto("/plan?horizon=365"); await expect(forecast).toContainText("Forecast unavailable");
      await reviewBookedBalances();
      await page.goto("/plan?horizon=365"); await expect(forecast).toContainText(`EUR ${(2000-futureCount*20).toFixed(2)}`);
      await page.goto(`/money/transactions?transaction=${ids[2]}`);
      await detail.getByRole("button",{name:"Undo verified link",exact:true}).click();
      await expect(detail.getByRole("heading",{name:"Verified transfer",exact:true})).toBeVisible();
      const [restored]=await db`select status,evidence_invalidated from public.recurring_series where assumption_id=${generated.id} and workspace_id=${workspace!}`;
      expect(restored).toMatchObject({status:"dismissed",evidence_invalidated:false});
      await reviewBookedBalances();
      await page.goto("/plan?horizon=365"); await expect(forecast).toContainText(expected);
      record("dismissed_fulfillment_correction_undo_verified");
      expect(await db`select id,posted_on::text,description,amount_minor::text,currency_code,merchant_id from public.transactions where workspace_id=${workspace!} order by id`).toEqual(original);
      expect(aiRequests).toBe(0); expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      record("lifecycle_verified", {aiRequests, futureCount});
    } finally {
      await context.close().catch(() => {});
      try {
        if (user) {
          const owned = await admin.auth.admin.getUserById(user);
          expect(owned.error).toBeNull();
          expect(owned.data.user?.user_metadata).toMatchObject({qa_test: "MNE014", run_id: runId});
          expect((await db`select count(*)::int as count from storage.objects where owner_id=${user}`)[0].count).toBe(0);
        }
        if (workspace && user) await db.begin(async tx => {
          expect((await tx`select id from public.workspaces where id=${workspace!} and owner_id=${user!}`).length).toBe(1);
          for (const table of ["transaction_link_fees", "transaction_links", "correction_events", "recurring_occurrence_settlements", "recurring_series_transactions", "recurring_series", "financial_assumptions", "balance_snapshots", "transactions", "forecast_preference_events", "forecast_preferences", "workspace_settings", "merchants", "accounts", "planning_events"]) {
            if(table==="transactions") await tx`update public.transactions set transfer_id=null,refund_of_id=null where workspace_id=${workspace!}`;
            await tx`delete from ${tx("public." + table)} where workspace_id=${workspace!}`;
            expect((await tx`select count(*)::int as count from ${tx("public." + table)} where workspace_id=${workspace!}`)[0].count).toBe(0);
          }
          await tx`delete from public.workspaces where id=${workspace!} and owner_id=${user!}`;
          expect((await tx`select count(*)::int as count from public.workspaces where id=${workspace!}`)[0].count).toBe(0);
        });
        if (user) {expect((await admin.auth.admin.deleteUser(user)).error).toBeNull(); expect((await db`select count(*)::int as count from auth.users where id=${user}`)[0].count).toBe(0);}
        if (migrationLedger) expect(await db`select version,name,statements from supabase_migrations.schema_migrations order by version`).toEqual(migrationLedger);
        record("cleanup", {remainingOwnedRecords: 0, exactCleanupZero: true, migrationLedgerUnchanged: true});
      } finally {await db.end();}
    }
  });
}
