import {test,expect,type BrowserContext} from '@playwright/test';
import {createClient} from '@supabase/supabase-js';
import {createServerClient} from '@supabase/ssr';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdirSync,writeFileSync} from 'node:fs';
import postgres from 'postgres';

test('noisy imported spending retains exact sources through reviewed organization, rules and atomic Undo',async({browser,baseURL},testInfo)=>{
 test.setTimeout(360000);
 for(const key of ['SUPABASE_DB_URL','SUPABASE_SERVICE_ROLE_KEY','NEXT_PUBLIC_SUPABASE_URL','NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'])expect(process.env[key],`${key} required`).toBeTruthy();
 const url=process.env.NEXT_PUBLIC_SUPABASE_URL!,connection=new URL(process.env.SUPABASE_DB_URL!);
 const project=new URL(url).hostname.split('.')[0];expect(connection.hostname===`db.${project}.supabase.co`||connection.username.endsWith('.'+project)).toBe(true);
 const run=randomUUID(),journal=`.qa/mne013-browser-${run}.json`,category=randomUUID();
 const db=postgres(connection.toString(),{ssl:'require',max:1,connect_timeout:10,onnotice:()=>{},connection:{application_name:'mne013-browser-'+run,lock_timeout:10000,statement_timeout:120000,idle_in_transaction_session_timeout:150000}});
 const admin=createClient(url,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false,autoRefreshToken:false}});
 let user:string|undefined,workspace:string|undefined,context:BrowserContext|undefined;
 const ledger:{version:string;name:string;statements:string[]}[]=[];
 mkdirSync('.qa',{recursive:true});
 const record=(extra:Record<string,unknown>)=>writeFileSync(journal,JSON.stringify({run,project,user,workspace,qaTest:'mne013-organization',...extra},null,2));
 try{
  ledger.push(...await db<typeof ledger>`select version,name,statements from supabase_migrations.schema_migrations order by version`);
  const deployed=ledger.find(row=>row.version==='202610080018');expect(deployed,'018 must be deployed').toBeTruthy();
  expect(createHash('sha256').update(deployed!.statements.join('\n')).digest('hex')).toBe('06404e13f93b1f7128ff84ead1819cbb8a98d3b719ccb619ed331c8fe32046e5');
  const email=`qa-${run}@example.invalid`,password=randomBytes(24).toString('hex');
  const created=await admin.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{qa_test:'mne013-organization',run_id:run}});
  expect(created.error).toBeNull();user=created.data.user!.id;
  [{id:workspace}]=await db`select id from public.workspaces where owner_id=${user}`;record({status:'open'});
  await db`insert into public.categories(id,workspace_id,name) values(${category},${workspace!},'QA Groceries')`;
  await db`insert into public.workspace_settings(workspace_id,ai_data_scopes,locale) values(${workspace!},'{}','en-US') on conflict(workspace_id) do update set ai_data_scopes='{}',locale='en-US'`;
  const cookies=new Map<string,string>();
  const auth=createServerClient(url,process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,{cookies:{getAll:()=>[...cookies].map(([name,value])=>({name,value})),setAll:values=>values.forEach(({name,value})=>cookies.set(name,value))}});
  expect((await auth.auth.signInWithPassword({email,password})).error).toBeNull();
  context=await browser.newContext({baseURL});await context.addCookies([...cookies].map(([name,value])=>({name,value,domain:'localhost',path:'/',sameSite:'Lax' as const})));
  const page=await context.newPage();page.setDefaultTimeout(30000);
  const importCsv=async(filename:string,csv:string)=>{
   await page.goto('/import');
   await expect(page.getByLabel('Financial statement files')).toBeEnabled();
   const inspected=page.waitForResponse(response=>response.url().endsWith('/api/imports/inspect')&&response.request().method()==='POST');
   await page.getByLabel('Financial statement files').setInputFiles({name:filename,mimeType:'text/csv',buffer:Buffer.from(csv)});expect((await inspected).ok()).toBe(true);
   await expect(page.getByText('Automatic interpretation unavailable. Choose the columns below.',{exact:true})).toBeVisible({timeout:20000});
   await page.getByLabel('Account name',{exact:true}).fill('Organization imported account');
   for(const name of ['Date','Description','Amount','External ID'])await page.getByRole('combobox',{name,exact:true}).selectOption(name==='External ID'?'id':name.toLowerCase());
   await page.getByRole('combobox',{name:'Source numeric convention'}).selectOption('decimal-dot');
   const previewed=page.waitForResponse(response=>response.url().endsWith('/api/imports/inspect')&&response.request().method()==='POST');
   await page.getByRole('button',{name:'Preview correction',exact:true}).click();expect((await previewed).ok()).toBe(true);
   const confirmed=page.waitForResponse(response=>response.url().endsWith('/api/imports/confirm')&&response.request().method()==='POST');
   await page.getByRole('button',{name:'Continue',exact:true}).click();const response=await confirmed;expect(response.ok()).toBe(true);
   const {importId}=await response.json();expect(importId).toMatch(/^[0-9a-f-]{36}$/);
   await expect.poll(async()=>{const [row]=await db`select status from public.imports where id=${importId} and workspace_id=${workspace!}`;return row.status;},{timeout:60000}).toBe('completed');
   await page.reload();
   await page.getByRole('region',{name:'Import history'}).locator('article').filter({hasText:filename}).getByRole('link',{name:'Organize imported spending',exact:true}).click();
   await expect(page).toHaveURL(new RegExp('/money/organization\\?import='+importId));return importId as string;
  };
  const imported=await importCsv('organization-no-categories.csv','date,description,amount,id\n2026-09-01,CARD PAYMENT CEDAR COOPERATIVE REF:101,-90071992547409.93,cedar-101\n2026-09-02,POS PURCHASE CEDAR COOPERATIVE REF:102,-1.00,cedar-102\n2026-09-03,MOSS TRAVEL REF:104,-2.00,moss-104\n');
  const rows=await db`select id,description,amount_minor::text,version,merchant_id,category_id from public.transactions where workspace_id=${workspace!} order by description`;
  expect(rows).toHaveLength(3);expect(rows.find(row=>row.description.includes('REF:101'))?.amount_minor).toBe('-9007199254740993');
  expect(rows.every(row=>row.merchant_id===null&&row.category_id===null)).toBe(true);
  const fingerprint=async()=>JSON.stringify({transactions:[...await db`select to_jsonb(t)-array['version','merchant_id','category_id','note'] as value from public.transactions t where workspace_id=${workspace!} order by id`],sources:[...await db`select id,original_row from public.source_transactions where workspace_id=${workspace!} order by id`],links:[...await db`select transaction_id,source_transaction_id from public.transaction_sources where source_transaction_id in(select id from public.source_transactions where workspace_id=${workspace!}) order by transaction_id,source_transaction_id`]});
  const before=await fingerprint();
  // One selectable queue: tick entries, then one searchable Category/Merchant bar applies to all of them.
  const queue=()=>page.getByRole('region',{name:'Organization suggestions'});
  const cedar=()=>queue().getByRole('listitem').filter({hasText:'CEDAR COOPERATIVE'});
  const selectCedar=async()=>{await expect(cedar()).toHaveCount(2,{timeout:20000});for(const box of await cedar().getByRole('checkbox').all())await box.check();await expect(queue()).toContainText('2 selected');};
  const pick=async(name:'Category'|'Merchant',value:string)=>queue().getByRole('combobox',{name,exact:true}).fill(value);
  const approve=async(saveRule:boolean)=>{
   await impact().getByRole('checkbox',{name:'I reviewed these entries',exact:false}).check();
   if(saveRule)await impact().getByRole('checkbox',{name:'Suggest the same for future entries',exact:false}).check();
   await impact().getByRole('button',{name:'Approve',exact:true}).click();await expect(impact().getByRole('heading',{name:'Applied',exact:true})).toBeVisible();
  };
  const rules=async()=>{const details=page.locator('details').filter({hasText:'Rules ('});if(!await details.evaluate(node=>(node as HTMLDetailsElement).open))await details.locator('summary').click();return details.locator('li').filter({hasText:'cedar cooperative'});};
  await selectCedar();
  await queue().getByRole('button',{name:'Suggest with AI',exact:true}).click();
  await expect(queue().getByRole('status')).toContainText('unavailable');
  await expect(queue().getByRole('combobox',{name:'Category',exact:true})).toBeEnabled();
  // Controlled delayed response validates browser draft ownership, not model quality.
  let fulfill!:()=>Promise<void>;let requested!:()=>void;
  const requestStarted=new Promise<void>(resolve=>{requested=resolve;});
  await page.route('**/api/money/organization/suggestions',async route=>{fulfill=()=>route.fulfill({json:{providerStatus:'available',proposals:rows.filter(row=>row.description.includes('CEDAR')).map(row=>({transactionId:row.id,basis:'provider-suggestion',merchantId:null,merchantName:'Obsolete suggestion',categoryId:category,evidenceQuote:'CEDAR COOPERATIVE'}))}});requested();});
  await queue().getByRole('button',{name:'Suggest with AI',exact:true}).click();await requestStarted;
  await pick('Merchant','Cedar Cooperative');await fulfill();
  await expect(queue().getByRole('status')).toContainText('draft changed');
  await expect(queue().getByRole('combobox',{name:'Merchant',exact:true})).toHaveValue('Cedar Cooperative');
  await page.unroute('**/api/money/organization/suggestions');
  await pick('Category','QA Groceries');
  await queue().getByRole('button',{name:'Preview changes',exact:true}).click();
  const impact=()=>page.getByRole('region',{name:'Organization impact preview'});
  await expect(impact()).toContainText('Merchant: unassigned → Cedar Cooperative');await expect(impact()).toContainText('Category: uncategorized → QA Groceries');
  await expect(impact()).toContainText('90071992547409.93');expect(await fingerprint()).toBe(before);
  await page.screenshot({path:testInfo.outputPath('native-organization-exact-preview.png'),fullPage:true});
  await approve(true);
  await page.reload();expect(await fingerprint()).toBe(before);
  const [rule]=await db`select id,enabled,version,merchant_id,category_id from public.organization_rules where workspace_id=${workspace!}`;
  expect(rule).toMatchObject({enabled:true,version:1,category_id:category});
  const first=rows.find(row=>row.description.includes('REF:101'))!;
  await page.goto('/money/transactions?transaction='+first.id);
  await page.getByRole('complementary',{name:'Transaction details'}).getByRole('button',{name:'Undo correction',exact:true}).click();
  await expect(page).toHaveURL(/\/money\/organization\?review=/);
  expect((await db`select version from public.transactions where id=${first.id} and workspace_id=${workspace!}`)[0].version).toBe(1);
  await impact().getByRole('button',{name:'Undo this batch',exact:true}).click();
  await expect(impact().getByRole('heading',{name:'Undone',exact:true})).toBeVisible();
  expect((await db`select enabled from public.organization_rules where id=${rule.id} and workspace_id=${workspace!}`)[0].enabled).toBe(false);
  expect((await db`select merchant_id,category_id,version from public.transactions where workspace_id=${workspace!} and description like '%CEDAR%'`).every(row=>row.merchant_id===null&&row.category_id===null&&row.version===2)).toBe(true);expect(await fingerprint()).toBe(before);
  // Undone corrections permit a fresh full preview and explicit rule approval; typed names resolve to the existing merchant and category.
  await page.goto('/money/organization?import='+imported);
  await selectCedar();await pick('Merchant','cedar cooperative');await pick('Category','qa groceries');
  await queue().getByRole('button',{name:'Preview changes',exact:true}).click();
  await expect(impact()).toContainText('Category: uncategorized → QA Groceries');
  await approve(true);
  expect((await db`select count(*)::int count from public.categories where workspace_id=${workspace!}`)[0].count).toBe(1);
  const originalSources=[...await db`select id,original_row from public.source_transactions where workspace_id=${workspace!} order by id`];
  await importCsv('organization-rule-reuse.csv','date,description,amount,id\n2026-09-04,CARD PAYMENT CEDAR COOPERATIVE REF:103,-3.00,cedar-103\n');
  const suggested=()=>cedar().getByRole('button',{name:'Cedar Cooperative · QA Groceries',exact:true});
  await expect(suggested()).toBeVisible();
  await (await rules()).getByRole('button',{name:'Disable',exact:true}).click();await expect(await rules()).toContainText('(off)');
  await expect(suggested()).toHaveCount(0);
  await (await rules()).getByRole('button',{name:'Enable',exact:true}).click();await expect(await rules()).not.toContainText('(off)');
  await expect(suggested()).toBeVisible();
  // Using the suggestion selects the entry and fills the bar.
  await suggested().click();await expect(queue().getByRole('combobox',{name:'Category',exact:true})).toHaveValue('QA Groceries');await expect(queue()).toContainText('1 selected');
  // A retained native correction suppresses later proposals without changing its source.
  const moss=rows.find(row=>row.description.includes('MOSS'))!;
  await page.goto('/money/transactions?transaction='+moss.id);
  const detail=page.getByRole('complementary',{name:'Transaction details'});
  await detail.getByLabel('Category',{exact:true}).fill('QA Groceries');await detail.getByLabel('Note',{exact:true}).fill('Retained owner correction');
  await detail.getByRole('button',{name:'Save correction',exact:true}).click();await expect(detail.getByLabel('Note',{exact:true})).toHaveValue('Retained owner correction');
  await expect.poll(async()=>{const [row]=await db`select category_id,note,version from public.transactions where id=${moss.id} and workspace_id=${workspace!}`;return row;}).toMatchObject({category_id:category,note:'Retained owner correction',version:1});
  await page.keyboard.press('Escape');await expect(detail).toHaveCount(0);await page.getByRole('link',{name:'Organize spending',exact:true}).click();
  await expect(page).toHaveURL(/\/money\/organization$/);
  await expect(page.getByRole('heading',{name:'Organize spending',exact:true})).toBeVisible();
  await expect(page.getByRole('region',{name:'Organization suggestions'}).getByRole('listitem').filter({hasText:'MOSS TRAVEL'})).toHaveCount(0);
  expect([...await db`select id,original_row from public.source_transactions where workspace_id=${workspace!} and id=any(${originalSources.map(row=>row.id)}) order by id`]).toEqual(originalSources);
  await page.screenshot({path:testInfo.outputPath('native-organization-rules-correction.png'),fullPage:true});
  record({status:'passed',exactSourcePreserved:true,provider:'disabled key/scopes; one controlled delayed HTTP fixture, no model-quality claim'});
 }finally{
  await context?.close().catch(()=>{});
  try{
   if(user){const owned=await admin.auth.admin.getUserById(user);expect(owned.error).toBeNull();expect(owned.data.user?.user_metadata).toMatchObject({qa_test:'mne013-organization',run_id:run});}
   const tables=await db`select table_name from information_schema.columns where table_schema='public' and column_name='workspace_id' order by table_name`;
   if(workspace){
    expect((await db`select owner_id from public.workspaces where id=${workspace}`)[0]?.owner_id).toBe(user);
    const paths=await db`select storage_path from public.imports where workspace_id=${workspace}`;
    for(const row of paths){expect(row.storage_path.startsWith(workspace+'/')).toBe(true);expect((await admin.storage.from('statements').remove([row.storage_path])).error).toBeNull();}
    expect((await db`select count(*)::int count from storage.objects where bucket_id='statements' and name like ${workspace+'/%'}`)[0].count).toBe(0);
    await db.begin(async tx=>{
     await tx`delete from public.transaction_sources where source_transaction_id in(select id from public.source_transactions where workspace_id=${workspace!})`;
     for(const table of ['organization_reviews','organization_rules','correction_events','transaction_batches','balance_snapshots','manual_transaction_entries','transactions','source_transactions','import_staging','import_control_events','imports','data_sources','accounts','categories','merchants','workspace_settings'])await tx`delete from ${tx('public.'+table)} where workspace_id=${workspace!}`;
     await tx`delete from public.workspaces where id=${workspace!} and owner_id=${user!}`;
    });
    for(const row of tables)expect((await db`select count(*)::int count from ${db('public.'+row.table_name)} where workspace_id=${workspace}`)[0].count,row.table_name+' exact cleanup').toBe(0);
    expect((await db`select id from public.workspaces where id=${workspace}`).length).toBe(0);
   }
   if(user){expect((await admin.auth.admin.deleteUser(user)).error).toBeNull();expect((await db`select id from auth.users where id=${user}`).length).toBe(0);}
   if(ledger.length)expect([...await db`select version,name,statements from supabase_migrations.schema_migrations order by version`]).toEqual(ledger);
   record({status:'cleaned',exactCleanupZero:true,migrationLedgerUnchanged:true,workspaceTables:tables.length});
  }finally{await db.end();}
 }
});
