import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import postgres from "postgres";

test.skip(!process.env.SUPABASE_DB_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, "Requires real disposable Supabase authentication, deployed051 and database fixtures");

test("durable import Stop, Resume, byte deduplication, undo and reimport preserve exact sources", async ({ browser, baseURL }) => {
  test.setTimeout(240_000);
  const url=process.env.E2E_IMPORT_PROXY_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL!, connection=new URL(process.env.SUPABASE_DB_URL!);
  const project=new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split(".")[0];
  expect(connection.hostname===`db.${project}.supabase.co` || connection.username.endsWith(`.${project}`)).toBe(true);
  const db=postgres(connection.toString(),{ssl:"require",max:1});
  const admin=createClient(url,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false,autoRefreshToken:false}});
  const email=`qa-${randomUUID()}@example.invalid`, password=randomBytes(24).toString("hex");
  const created=await admin.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{qa_test:"import-control"}});
  expect(created.error).toBeNull();
  const user=created.data.user!.id;
  const [{id:workspace}]=await db`select id from public.workspaces where owner_id=${user}`;
  const recovery=process.env.E2E_IMPORT_BATCH_JOURNAL ?? `.qa/import-control-${user}.json`;
  mkdirSync(".qa",{recursive:true});writeFileSync(recovery,JSON.stringify({project,user,workspace,qaTest:"import-control"}));
  const context=await browser.newContext({baseURL});
  try {
    const ready=await db`select to_regprocedure('public.control_import(uuid,text,uuid)') is not null as ready`;
    expect(ready[0].ready,"051 must be deployed; a missing required gate is not a pass").toBe(true);
    await db`insert into public.workspace_settings(workspace_id,ai_data_scopes) values(${workspace},'{}') on conflict(workspace_id) do update set ai_data_scopes='{}'`;
    const cookies=new Map<string,string>();
    const auth=createServerClient(url,process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,{cookies:{getAll:()=>[...cookies].map(([name,value])=>({name,value})),setAll:values=>values.forEach(({name,value})=>cookies.set(name,value))}});
    expect((await auth.auth.signInWithPassword({email,password})).error).toBeNull();
    await context.addCookies([...cookies].map(([name,value])=>({name,value,domain:"localhost",path:"/",sameSite:"Lax" as const})));
    const page=await context.newPage();page.setDefaultTimeout(30_000);
    const filename="controlled-1000.csv", accountName="Controlled cash";
    const csv=["date,description,amount,id",...Array.from({length:1000},(_,i)=>`2026-09-01,Synthetic expense ${String(i+1).padStart(3,"0")},-1.01,controlled-${i+1}`),""].join("\n");
    const file={name:filename,mimeType:"text/csv",buffer:Buffer.from(csv)};
    await page.goto("/import");
    await expect(page.getByLabel("Financial statement files")).toBeEnabled();
    // The scoped-out (scopes {}) inspect completes auth/workspace/settings then
    // scope-denial; its duration varies past the default 5s on cold servers while
    // "Working…" stays visible. Await the exact POST (as for confirm below and the
    // theme Save sync) instead of racing it, then assert boundedly.
    const fallbackInspect=page.waitForResponse(response=>response.url().endsWith("/api/imports/inspect")&&response.request().method()==="POST");
    await page.getByLabel("Financial statement files").setInputFiles(file);
    expect((await fallbackInspect).ok()).toBe(true);
    await expect(page.getByText("Automatic interpretation unavailable. Choose the columns below.",{exact:true})).toBeVisible({timeout:20_000});
    await page.getByLabel("Account name",{exact:true}).fill(accountName);
    await page.getByRole("combobox",{name:"Date",exact:true}).selectOption("date");
    await page.getByRole("combobox",{name:"Description",exact:true}).selectOption("description");
    await page.getByRole("combobox",{name:"Amount",exact:true}).selectOption("amount");
    await page.getByRole("combobox",{name:"External ID",exact:true}).selectOption("id");
    await page.getByRole("combobox",{name:"Source numeric convention"}).selectOption("decimal-dot");
    const previewInspect=page.waitForResponse(response=>response.url().endsWith("/api/imports/inspect")&&response.request().method()==="POST");
    await page.getByRole("button",{name:"Preview correction",exact:true}).click();
    expect((await previewInspect).ok()).toBe(true);
    await expect(page.getByText("1000 rows",{exact:true})).toBeVisible({timeout:20_000});
    const confirmResponse=page.waitForResponse(response=>response.url().endsWith("/api/imports/confirm")&&response.request().method()==="POST");
    await page.getByRole("button",{name:"Continue",exact:true}).click();
    const response=await confirmResponse;expect(response.ok()).toBe(true);
    const {importId}=await response.json();expect(importId).toMatch(/^[0-9a-f-]{36}$/);
    const history=page.getByRole("region",{name:"Import history"}).locator("article").filter({hasText:filename});
    const counts=async()=>{
      const [row]=await db`select (select count(*)::int from public.source_transactions where import_id=${importId}) as sources,(select count(*)::int from public.transactions where workspace_id=${workspace}) as transactions`;
      return row as {sources:number;transactions:number};
    };
    await expect.poll(async()=>{const row=await counts();return row.sources>0&&row.sources<1000;},{timeout:60_000,intervals:[100]}).toBe(true);
    const initial=[...(await db`select id,row_number,original_row from public.source_transactions where import_id=${importId} order by row_number`)];
    const stopResponse=page.waitForResponse(response=>response.url().endsWith(`/api/imports/${importId}/control`)&&response.request().method()==="POST");
    await history.getByRole("button",{name:"Stop import",exact:true}).click();
    expect((await stopResponse).ok()).toBe(true);
    await expect(history.getByRole("status")).toHaveText("canceled");
    const stopped=await counts();expect(stopped.sources).toBeGreaterThan(0);expect(stopped.sources).toBeLessThan(1000);expect(stopped.transactions).toBe(stopped.sources);
    const [{run_version:stoppedVersion,source_id:source,storage_path:storagePath}]=await db`select run_version,source_id,storage_path from public.imports where id=${importId} and workspace_id=${workspace}`;
    const [{account_id:account}]=await db`select account_id from public.data_sources where id=${source} and workspace_id=${workspace}`;
    const stale=await admin.rpc("ingest_import_row",{p_import_id:importId,p_workspace_id:workspace,p_run_version:stoppedVersion-1,p_account_id:account,p_row:{transactionId:randomUUID()}});
    expect(stale.error?.code).toBe("57014");expect(stale.error?.message).toContain("canceled or superseded");
    // Observe a real retry window. Old workers also remain rejected after Resume.
    for(let i=0;i<8;i++){await page.waitForTimeout(1000);expect(await counts()).toEqual(stopped);}
    const retained=await db`select id,row_number,original_row from public.source_transactions where import_id=${importId} order by row_number`;
    expect(retained.slice(0,initial.length)).toEqual(initial);
    await history.getByRole("button",{name:"Resume import",exact:true}).click();
    await expect(history.getByRole("status")).toHaveText("completed",{timeout:90_000});
    expect(await counts()).toEqual({sources:1000,transactions:1000});
    await expect(history).toContainText("1000 new");await expect(history).toContainText("1000 total");
    const [exact]=await db`select count(*)::int as count,count(distinct id)::int as unique_ids,sum(amount_minor)::text as total from public.transactions where workspace_id=${workspace}`;
    expect(exact).toEqual({count:1000,unique_ids:1000,total:"-101000"});
    const [sourceRows]=await db`select count(distinct row_number)::int as unique_rows,count(*)::int as count from public.source_transactions where import_id=${importId}`;
    expect(sourceRows).toEqual({unique_rows:1000,count:1000});
    expect((await db`select count(*)::int as count from public.saved_analyses where workspace_id=${workspace}`)[0].count).toBe(0);
    expect(await db`select id,row_number,original_row from public.source_transactions where import_id=${importId} order by row_number limit ${initial.length}`).toEqual(initial);
    const oldAfterResume=await admin.rpc("ingest_import_row",{p_import_id:importId,p_workspace_id:workspace,p_run_version:stoppedVersion-1,p_account_id:account,p_row:{transactionId:randomUUID()}});
    expect(oldAfterResume.error?.code).toBe("57014");
    const multipart={file:{name:filename,mimeType:"text/csv",buffer:Buffer.from(csv)},mapping:JSON.stringify({accountName,currencyCode:"EUR",dateColumn:"date",descriptionColumn:"description",amountColumn:"amount",externalIdColumn:"id",dateFormat:"iso",amountSign:"signed",numericConvention:"decimal-dot"})};
    const repeated=await context.request.post("/api/imports/confirm",{multipart});
    expect(repeated.ok()).toBe(true);expect((await repeated.json()).importId).toBe(importId);
    expect((await db`select count(*)::int as count from public.imports where workspace_id=${workspace}`)[0].count).toBe(1);
    const undoPreview=page.waitForResponse(response=>response.url().endsWith(`/api/imports/${importId}/undo`)&&response.request().method()==="GET");
    await history.getByRole("button",{name:"Undo import",exact:true}).click();
    expect((await undoPreview).ok()).toBe(true);
    await expect(history).toContainText("remove 1000 transactions and 0 balance snapshots");
    const undoResponse=page.waitForResponse(response=>response.url().endsWith(`/api/imports/${importId}/undo`)&&response.request().method()==="POST");
    await history.getByRole("button",{name:"Confirm undo 1000 transactions",exact:true}).click();
    expect((await undoResponse).ok()).toBe(true);
    await expect(history).toHaveCount(0);
    expect((await db`select status from public.imports where id=${importId}`)[0].status).toBe("undone");
    await expect.poll(async()=> (await counts()).transactions).toBe(0);
    expect((await counts()).sources).toBe(1000);
    expect((await db`select count(*)::int as count from public.transaction_sources l join public.source_transactions s on s.id=l.source_transaction_id where s.workspace_id=${workspace}`)[0].count).toBe(0);
    const [originals]=await db`select count(*)::int as count from public.source_transactions where import_id=${importId} and original_row->>'amount'='-1.01'`;
    expect(originals.count).toBe(1000);
    expect(storagePath.startsWith(`${workspace}/`)).toBe(true);
    const originalFile=await admin.storage.from("imports").download(storagePath);expect(originalFile.error).toBeNull();
    expect(await originalFile.data!.text()).toBe(csv);
    const undoneSources=await db`select id,row_number,original_row,status from public.source_transactions where import_id=${importId} order by row_number`;
    const reimport=await context.request.post("/api/imports/confirm",{multipart});
    expect(reimport.ok()).toBe(true);
    const fresh=await reimport.json();expect(fresh.importId).not.toBe(importId);expect(fresh.status).toBe("queued");
    await expect.poll(async()=> (await db`select status from public.imports where id=${fresh.importId}`)[0].status,{timeout:90_000}).toBe("completed");
    await page.reload();
    await expect(history.getByRole("status")).toHaveText("completed");
    const [reimported]=await db`select count(*)::int as count,count(distinct id)::int as unique_ids,sum(amount_minor)::text as total from public.transactions where workspace_id=${workspace}`;
    expect(reimported).toEqual({count:1000,unique_ids:1000,total:"-101000"});
    expect(await db`select id,row_number,original_row,status from public.source_transactions where import_id=${importId} order by row_number`).toEqual(undoneSources);
    expect((await db`select count(*)::int as count from public.source_transactions where import_id=${fresh.importId}`)[0].count).toBe(1000);
    expect((await db`select count(*)::int as count from public.transaction_sources l join public.source_transactions s on s.id=l.source_transaction_id where s.workspace_id=${workspace}`)[0].count).toBe(1000);
    const freshDuplicate=await context.request.post("/api/imports/confirm",{multipart});
    expect(freshDuplicate.ok()).toBe(true);expect((await freshDuplicate.json()).importId).toBe(fresh.importId);
    expect((await db`select count(*)::int as count from public.imports where workspace_id=${workspace}`)[0].count).toBe(2);
  } finally {
    await context.close().catch(()=>{});
    // Cancel under the same ownership/version lock as ingestion before removing any sources.
    // Once committed, every old worker's next write is rejected at the database boundary.
    await db.begin(async tx=>{
      await tx`select set_config('request.jwt.claim.sub',${user},true)`;
      const active=await tx`select id from public.imports where workspace_id=${workspace} and status in('pending','queued','running')`;
      for(const row of active)await tx`select public.control_import(${row.id},'cancel',${randomUUID()})`;
      const reviews=await tx`select id from public.background_jobs where workspace_id=${workspace} and kind='financial_review' and status in('queued','running')`;
      for(const row of reviews)await tx`select public.cancel_financial_review(${row.id})`;
    });
    const files=await db`select storage_path from public.imports where workspace_id=${workspace}`;
    for(const file of files)expect(file.storage_path.startsWith(`${workspace}/`)).toBe(true);
    const stored=await admin.storage.from("imports").list(workspace,{limit:1000});expect(stored.error).toBeNull();
    const paths=(stored.data??[]).map(file=>{expect(file.name).toMatch(/^[a-f0-9]{64}\.csv$/);return `${workspace}/${file.name}`;});
    if(paths.length){const removed=await admin.storage.from("imports").remove(paths);expect(removed.error).toBeNull();}
    await db.begin(async tx=>{
      expect(await tx`select id from public.workspaces where id=${workspace} and owner_id=${user}`).toHaveLength(1);
      await tx`delete from public.transaction_sources where source_transaction_id in(select id from public.source_transactions where workspace_id=${workspace})`;
      for(const table of ["saved_analyses","background_jobs","import_control_events","balance_snapshots","transactions","source_transactions","imports","data_sources","accounts","merchants","categories"])await tx`delete from ${tx("public."+table)} where workspace_id=${workspace}`;
      await tx`delete from public.workspaces where id=${workspace} and owner_id=${user}`;
    });
    expect((await admin.auth.admin.deleteUser(user)).error).toBeNull();
    expect(await db`select id from public.workspaces where id=${workspace} or owner_id=${user}`).toHaveLength(0);
    expect(await db`select id from auth.users where id=${user}`).toHaveLength(0);
    expect((await admin.storage.from("imports").list(workspace,{limit:1000})).data).toEqual([]);
    unlinkSync(recovery);await db.end();
  }
});
