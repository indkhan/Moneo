import { test, expect } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import postgres from "postgres";
import ExcelJS from "exceljs";

test.skip(!process.env.SUPABASE_DB_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, "Requires real disposable Supabase authentication, deployed051 and database fixtures");

test("reviewed workbook scope imports only selected financial tables with exact timestamp evidence", async ({ browser, baseURL }) => {
  test.setTimeout(240_000);
  const url=process.env.NEXT_PUBLIC_SUPABASE_URL!, connection=new URL(process.env.SUPABASE_DB_URL!);
  const project=new URL(url).hostname.split(".")[0];
  expect(connection.hostname===`db.${project}.supabase.co` || connection.username.endsWith(`.${project}`)).toBe(true);
  const db=postgres(connection.toString(),{ssl:"require",max:1});
  const admin=createClient(url,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false,autoRefreshToken:false}});
  const email=`qa-${randomUUID()}@example.invalid`, password=randomBytes(24).toString("hex");
  const created=await admin.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{qa_test:"workbook-scope"}});
  expect(created.error).toBeNull();
  const user=created.data.user!.id;
  const [{id:workspace}]=await db`select id from public.workspaces where owner_id=${user}`;
  const recovery=`.qa/workbook-scope-${user}.json`;
  mkdirSync(".qa",{recursive:true});writeFileSync(recovery,JSON.stringify({project,user,workspace}));
  const context=await browser.newContext({baseURL});
  try {
    const ready=await db`select to_regprocedure('public.control_import(uuid,text,uuid)') is not null as ready`;
    expect(ready[0].ready,"051 must be deployed; a missing required gate is not a pass").toBe(true);
    await db`insert into public.workspace_settings(workspace_id,ai_data_scopes) values(${workspace},'{}') on conflict(workspace_id) do update set ai_data_scopes='{}'`;
    const cookies=new Map<string,string>();
    const auth=createServerClient(url,process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,{cookies:{getAll:()=>[...cookies].map(([name,value])=>({name,value})),setAll:values=>values.forEach(({name,value})=>cookies.set(name,value))}});
    expect((await auth.auth.signInWithPassword({email,password})).error).toBeNull();
    await context.addCookies([...cookies].map(([name,value])=>({name,value,domain:new URL(baseURL!).hostname,path:"/",sameSite:"Lax" as const})));
    const page=await context.newPage();page.setDefaultTimeout(30_000);
    const book = new ExcelJS.Workbook();
    book.addWorksheet("Summary").addRows([["Label","Value"],["Not a posting","999.00"]]);
    const checking=book.addWorksheet("Checking");
    checking.addRows([["Statement title"],[],["Date","Description","Amount"],[new Date("2026-09-01T14:25:30.123Z"),"Selected checking","-12.34"],[],["Date","Description","Amount"],["2026-09-02","Selected second table","3.00"]]);
    const savings=book.addWorksheet("Savings");savings.addRows([["Date","Description","Amount"],["2026-09-03","Selected savings","20.00"]]);
    book.addWorksheet("Hidden",{state:"hidden"}).addRows([["Date","Description","Amount"],["2026-09-04","Omitted hidden","999.00"]]);
    book.addWorksheet("Empty");
    const file={name:"reviewed-tables.xlsx",mimeType:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",buffer:Buffer.from(await book.xlsx.writeBuffer())};
    await page.goto("/import");
    await expect(page.getByLabel("Financial statement files")).toBeEnabled();
    const first=page.waitForResponse(r=>r.url().endsWith("/api/imports/inspect")&&r.request().method()==="POST");
    await page.getByLabel("Financial statement files").setInputFiles(file);
    const inventory=await (await first).json();expect(inventory.needsWorkbookSelection).toBe(true);expect(inventory.mapping).toBeNull();expect(inventory.workbook.inventory).toHaveLength(5);
    const scope=page.getByRole("region",{name:"Workbook scope"});
    await expect(scope.getByLabel("Include Empty",{exact:true})).toBeDisabled();
    await scope.getByLabel("Include Checking",{exact:true}).check();
    await scope.getByLabel("Header row for Checking table 1",{exact:true}).fill("3");
    await scope.getByLabel("Last row for Checking table 1",{exact:true}).fill("4");
    await scope.getByRole("button",{name:"Add another table from Checking",exact:true}).click();
    await scope.getByLabel("Header row for Checking table 2",{exact:true}).fill("6");
    await scope.getByLabel("Last row for Checking table 2",{exact:true}).fill("7");
    await scope.getByLabel("Include Savings",{exact:true}).check();
    await expect(scope).toContainText("Excluded worksheets: Summary, Hidden, Empty");
    const selected=page.waitForResponse(r=>r.url().endsWith("/api/imports/inspect")&&r.request().method()==="POST");
    await scope.getByRole("button",{name:"Preview selected tables",exact:true}).click();
    const selectedJson=await (await selected).json();expect(selectedJson.sample.map((r:{Description:string})=>r.Description)).toEqual(["Selected checking","Selected second table","Selected savings"]);
    await page.getByLabel("Account name",{exact:true}).fill("Reviewed workbook cash");
    await page.getByRole("combobox",{name:"Source numeric convention"}).selectOption("decimal-dot");
    const preview=page.waitForResponse(r=>r.url().endsWith("/api/imports/inspect")&&r.request().method()==="POST");
    await page.getByRole("button",{name:"Preview correction",exact:true}).click();expect((await preview).ok()).toBe(true);
    await expect(page.getByText("3 rows",{exact:true})).toBeVisible();
    await expect(page.getByLabel("Source timestamp timezone",{exact:true})).toHaveValue("Europe/Berlin");
    await page.getByRole("checkbox",{name:"I confirmed this timezone matches the statement's source clock."}).check();
    const confirm=page.waitForResponse(r=>r.url().endsWith("/api/imports/confirm")&&r.request().method()==="POST");
    await page.getByRole("button",{name:"Continue",exact:true}).click();const response=await confirm;expect(response.ok()).toBe(true);const {importId}=await response.json();
    await expect.poll(async()=> (await db`select status from public.imports where id=${importId} and workspace_id=${workspace}`)[0].status,{timeout:90_000}).toBe("completed");
    const [stored]=await db`select mapping,total_rows,file_hash,storage_path from public.imports where id=${importId} and workspace_id=${workspace}`;
    expect(stored.total_rows).toBe(3);expect(stored.mapping.workbookScope).toEqual({version:"xlsx-scope-v1",tables:[{sheetId:checking.id,headerRow:3,endRow:4},{sheetId:checking.id,headerRow:6,endRow:7},{sheetId:savings.id,headerRow:1,endRow:2}]});
    const originals=await db`select id,row_number,original_row,normalized_row from public.source_transactions where import_id=${importId} and workspace_id=${workspace} order by row_number`;
    expect(originals).toHaveLength(3);
    expect(originals[0].original_row.Date).toBe("2026-09-01T14:25:30.123");
    expect(JSON.parse(originals[0].original_row.__moneo_csv_xlsx_source)).toMatchObject({sheetName:"Checking",headerRow:3,rowNumber:4,cells:{Date:{value:"2026-09-01T14:25:30.123Z"}}});
    const txs=await db`select amount_minor::text,posted_at::text from public.transactions where workspace_id=${workspace} order by posted_on`;
    expect(txs.map(t=>t.amount_minor)).toEqual(["-1234","300","2000"]);expect(txs[0].posted_at).toContain("12:25:30.123");
    const duplicate=await context.request.post("/api/imports/confirm",{multipart:{file,mapping:JSON.stringify(stored.mapping)}});expect(duplicate.ok()).toBe(true);expect((await duplicate.json()).importId).toBe(importId);
    const changed=await context.request.post("/api/imports/confirm",{multipart:{file,mapping:JSON.stringify({...stored.mapping,workbookScope:{version:"xlsx-scope-v1",tables:[{sheetId:savings.id,headerRow:1,endRow:2}]}})}});expect(changed.status()).toBe(409);
    expect(await db`select id,row_number,original_row,normalized_row from public.source_transactions where import_id=${importId} and workspace_id=${workspace} order by row_number`).toEqual(originals);
    const downloaded=await admin.storage.from("imports").download(stored.storage_path);expect(downloaded.error).toBeNull();expect(Buffer.from(await downloaded.data!.arrayBuffer())).toEqual(file.buffer);
    // An owned fault fixture exercises real retry of the same frozen file/scope.
    // Existing source rows must survive the replay unchanged, with no extra postings.
    await db`update public.imports set status='failed',error='Synthetic retry fixture' where id=${importId} and workspace_id=${workspace}`;
    await page.reload();
    const history=page.getByRole("region",{name:"Import history"}).locator("article").filter({hasText:file.name});
    await history.getByRole("button",{name:"Retry",exact:true}).click();
    await expect(history.getByRole("status")).toHaveText("completed",{timeout:90_000});
    expect(await db`select id,row_number,original_row,normalized_row from public.source_transactions where import_id=${importId} and workspace_id=${workspace} order by row_number`).toEqual(originals);
    expect((await db`select count(*)::int as count from public.transactions where workspace_id=${workspace}`)[0].count).toBe(3);
    expect((await db`select mapping from public.imports where id=${importId} and workspace_id=${workspace}`)[0].mapping).toEqual(stored.mapping);
    await history.getByRole("link",{name:"Review rows and source coverage"}).click();
    await expect(page.getByRole("heading",{name:"Source coverage",exact:true})).toBeVisible();
  } finally {
    await context.close().catch(()=>{});
    expect((await db`select owner_id from public.workspaces where id=${workspace}`)[0]?.owner_id).toBe(user);
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
    const paths=(stored.data??[]).map(file=>{expect(file.name).toMatch(/^[a-f0-9]{64}\.(csv|xlsx)$/);return `${workspace}/${file.name}`;});
    if(paths.length){const removed=await admin.storage.from("imports").remove(paths);expect(removed.error).toBeNull();}
    await db.begin(async tx=>{
      await tx`delete from public.transaction_sources where source_transaction_id in(select id from public.source_transactions where workspace_id=${workspace})`;
      for(const table of ["saved_analyses","background_jobs","import_control_events","balance_snapshots","transactions","source_transactions","imports","data_sources","accounts","merchants","categories"])await tx`delete from ${tx("public."+table)} where workspace_id=${workspace}`;
      await tx`delete from public.workspaces where id=${workspace} and owner_id=${user}`;
    });
    expect((await admin.auth.admin.deleteUser(user)).error).toBeNull();
    expect((await db`select count(*)::int as count from public.workspaces where id=${workspace}`)[0].count).toBe(0);
    expect((await db`select count(*)::int as count from auth.users where id=${user}`)[0].count).toBe(0);
    writeFileSync(recovery.replace(".json","-cleaned.json"),JSON.stringify({cleaned:true,workspaceRemaining:0,authUserRemaining:0}));unlinkSync(recovery);await db.end();
  }
});
