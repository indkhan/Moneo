import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import postgres from "postgres";
test.skip(!process.env.SUPABASE_DB_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, "Requires real disposable Supabase authentication and database fixtures");

test("source correction invalidates the inferred forecast obligation and undo restores it",async({browser})=>{
  test.setTimeout(180_000);
  const url=process.env.NEXT_PUBLIC_SUPABASE_URL!,connection=new URL(process.env.SUPABASE_DB_URL!);
  const project=new URL(url).hostname.split(".")[0];
  expect(connection.hostname===`db.${project}.supabase.co`||connection.username.endsWith(`.${project}`)).toBe(true);
  const db=postgres(connection.toString(),{ssl:"require",max:1,connect_timeout:10,connection:{application_name:"MNE014-browser-source",lock_timeout:10_000,statement_timeout:120_000,idle_in_transaction_session_timeout:150_000}});
  const admin=createClient(url,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false,autoRefreshToken:false}});
  const runId=randomUUID(),email=`qa-${runId}@example.invalid`,password=randomBytes(24).toString("hex");
  let user:string|undefined,workspace:string|undefined,migrationLedger:unknown;
  const recovery=`.qa/recurring-${runId}.json`;
  const context=await browser.newContext({baseURL:"http://localhost:3000"});
  try {
  migrationLedger=await db`select version,name,statements from supabase_migrations.schema_migrations order by version`;
  const created=await admin.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{qa_test:"recurring-source",run_id:runId}});expect(created.error).toBeNull();
  user=created.data.user!.id;[{id:workspace}]=await db`select id from public.workspaces where owner_id=${user}`;
  mkdirSync(".qa",{recursive:true});writeFileSync(recovery,JSON.stringify({project,runId,user,workspace}));
  const cookies=new Map<string,string>();
  const auth=createServerClient(url,process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,{cookies:{getAll:()=>[...cookies].map(([name,value])=>({name,value})),setAll:values=>values.forEach(({name,value})=>cookies.set(name,value))}});
  expect((await auth.auth.signInWithPassword({email,password})).error).toBeNull();
  await context.addCookies([...cookies].map(([name,value])=>({name,value,domain:"localhost",path:"/",sameSite:"Lax" as const})));
  const page=await context.newPage();page.setDefaultTimeout(30_000);
  const suffix=crypto.randomUUID().slice(0,8), label=`Recurring evidence QA ${suffix}`;
  const accountNames=[`Recurring source QA ${suffix}`,`Recurring counterpart QA ${suffix}`];
  for(const [index,name] of accountNames.entries()){
    const account=randomUUID();await db`insert into public.accounts(id,workspace_id,name,currency_code,type) values(${account},${workspace!},${name},'EUR','checking')`;
    await db`insert into public.balance_snapshots(workspace_id,account_id,amount_minor,currency_code,as_of,provenance) values(${workspace!},${account},${index?0:100000},'EUR',now(),'manual')`;
  }
  await db`insert into public.forecast_preferences(workspace_id,currency_code,uncertainty_bps) values(${workspace!},'EUR',0)`;
  const sourceUrls:string[]=[];const credit=`Recurring matching credit QA ${suffix}`;
  for(let i=0;i<4;i++){
    await page.goto("/money/transactions");await page.getByText("Add a manual transaction",{exact:true}).click();
    const manual=page.locator("form").filter({has:page.getByRole("button",{name:"Add transaction",exact:true})});
    await manual.getByRole("combobox",{name:"Account",exact:true}).selectOption({label:`${accountNames[i===3?1:0]} (EUR)`});
    await manual.getByLabel("Description",{exact:true}).fill(i===3?credit:label);
    await manual.getByLabel("Posting date",{exact:true}).fill(i===3?"2026-09-15":`2026-0${i+7}-15`);
    await manual.getByLabel("Signed decimal amount").fill(i===3?"10.00":"-10.00");
    await manual.getByRole("button",{name:"Add transaction",exact:true}).click();
    await page.waitForURL(/transaction=[0-9a-f-]{36}/,{timeout:30_000});sourceUrls.push(page.url());
  }
  await page.goto("/money/recurring");
  const series=page.locator("article").filter({has:page.getByRole("heading",{name:label,exact:true})});
  await expect(series).toContainText("3 observed payments");
  await series.getByRole("button",{name:"Confirm",exact:true}).click();
  await expect(series).toContainText("Confirmed",{timeout:30_000});
  await page.goto("/plan");
  const assumption=page.locator("li").filter({has:page.getByRole("heading",{name:label,exact:true})});
  await expect(assumption).toContainText("Source: recurring_confirmed");await expect(assumption).toContainText("active in forecast");
  const forecast=page.locator("section").filter({has:page.getByRole("heading",{name:"Liquid balance horizon",exact:true})});
  await expect(forecast).toContainText("EUR 990.00");await expect(forecast).not.toContainText("Forecast unavailable");
  await page.goto(`${sourceUrls[2]}&linkSearch=${encodeURIComponent(credit)}`);
  const detail=page.getByRole("complementary",{name:"Transaction details"});
  const transfer=detail.locator("form").filter({has:page.getByRole("heading",{name:"Verified transfer",exact:true})});
  const choices=transfer.getByRole("combobox",{name:"Transfer counterpart",exact:true});
  const choice=await choices.locator("option").filter({hasText:credit}).getAttribute("value");await choices.selectOption(choice!);
  await transfer.getByRole("checkbox").check();await transfer.getByRole("button",{name:"Confirm verified transfer",exact:true}).click();
  await expect(detail.getByText("Transfer pair:",{exact:false})).toBeVisible({timeout:30_000});
  await page.goto("/money/recurring");
  await expect(page.getByRole("heading",{name:"Confirmed source evidence changed",exact:true})).toBeVisible();
  await page.goto("/plan");
  const disabled=page.locator("li").filter({has:page.getByRole("heading",{name:`${label} (disabled)`,exact:true})});
  await expect(disabled).toContainText("excluded from forecast");
  await expect(disabled).toContainText("Current value: -EUR 10.00");
  await expect(forecast).toContainText("EUR 1000.00");await expect(forecast).not.toContainText("EUR 990.00");
  await page.goto(sourceUrls[2]);await detail.getByRole("button",{name:"Undo verified link",exact:true}).click();
  await expect(detail.getByRole("heading",{name:"Verified transfer",exact:true})).toBeVisible({timeout:30_000});
  await expect(detail.locator('pre[aria-label="Original source evidence"]')).toContainText('"amount_minor": "-1000"');
  await page.goto("/money/recurring");await expect(series).toContainText("Confirmed");
  await expect(page.getByRole("heading",{name:"Confirmed source evidence changed",exact:true})).not.toBeVisible();
  await page.goto("/plan");await expect(assumption).toContainText("active in forecast");
  await expect(assumption).toContainText("Source: recurring_confirmed");
  await expect(forecast).toContainText("EUR 990.00");
  expect((await db`select count(*)::int as count from public.transactions where workspace_id=${workspace!}`)[0].count).toBe(4);
  expect((await db`select sum(amount_minor)::text as amount from public.balance_snapshots where workspace_id=${workspace!}`)[0].amount).toBe("100000");
  } finally {
    await context.close().catch(()=>{});
    try {
      if(user){
        const owned=await admin.auth.admin.getUserById(user);expect(owned.error).toBeNull();
        expect(owned.data.user?.user_metadata).toMatchObject({qa_test:"recurring-source",run_id:runId});
        expect((await db`select count(*)::int as count from storage.objects where owner_id=${user}`)[0].count).toBe(0);
      }
      if(workspace&&user)await db.begin(async tx=>{
        expect((await tx`select id from public.workspaces where id=${workspace!} and owner_id=${user!}`).length).toBe(1);
        for(const table of ["transaction_link_fees","transaction_links","correction_events","recurring_occurrence_settlements","recurring_series_transactions","recurring_series"]) {
          await tx`delete from ${tx("public."+table)} where workspace_id=${workspace!}`;
          expect((await tx`select count(*)::int as count from ${tx("public."+table)} where workspace_id=${workspace!}`)[0].count).toBe(0);
        }
        await tx`update public.transactions set transfer_id=null,refund_of_id=null where workspace_id=${workspace!}`;
        for(const table of ["financial_assumptions","manual_transaction_entries","balance_snapshots","transactions","forecast_preference_events","forecast_preferences","accounts","planning_events"]) {
          await tx`delete from ${tx("public."+table)} where workspace_id=${workspace!}`;
          expect((await tx`select count(*)::int as count from ${tx("public."+table)} where workspace_id=${workspace!}`)[0].count).toBe(0);
        }
        await tx`delete from public.workspaces where id=${workspace!} and owner_id=${user!}`;
        expect((await tx`select count(*)::int as count from public.workspaces where id=${workspace!}`)[0].count).toBe(0);
      });
      if(user){expect((await admin.auth.admin.deleteUser(user)).error).toBeNull();expect((await db`select count(*)::int as count from auth.users where id=${user}`)[0].count).toBe(0);unlinkSync(recovery);}
      if(migrationLedger)expect(await db`select version,name,statements from supabase_migrations.schema_migrations order by version`).toEqual(migrationLedger);
    } finally {await db.end();}
  }
});
