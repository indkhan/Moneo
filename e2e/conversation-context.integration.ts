import {test,expect,type BrowserContext,type Locator} from '@playwright/test';
import {createClient} from '@supabase/supabase-js';
import {createServerClient} from '@supabase/ssr';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import postgres from 'postgres';

test('owned context retains choices and pins while current evidence and shared native controls stay bounded',async({browser,baseURL},testInfo)=>{
 test.setTimeout(360000);
 for(const key of ['SUPABASE_DB_URL','SUPABASE_SERVICE_ROLE_KEY','NEXT_PUBLIC_SUPABASE_URL','NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY'])expect(process.env[key],key+' required').toBeTruthy();
 const url=process.env.NEXT_PUBLIC_SUPABASE_URL!,connection=new URL(process.env.SUPABASE_DB_URL!);
 const project=new URL(url).hostname.split('.')[0];expect(connection.hostname===`db.${project}.supabase.co`||connection.username.endsWith('.'+project)).toBe(true);
 const run=randomUUID(),journal=`.qa/mne025-browser-${run}.json`,account=randomUUID(),posting=randomUUID();
 const db=postgres(connection.toString(),{ssl:'require',max:1,connect_timeout:10,onnotice:()=>{},connection:{application_name:'mne025-browser-'+run,lock_timeout:10000,statement_timeout:120000,idle_in_transaction_session_timeout:150000}});
 const admin=createClient(url,process.env.SUPABASE_SERVICE_ROLE_KEY!,{auth:{persistSession:false,autoRefreshToken:false}});
 let user:string|undefined,workspace:string|undefined,context:BrowserContext|undefined,failure:string|undefined;
 const ledger:{version:string;name:string;statements:string[]}[]=[];
 mkdirSync('.qa',{recursive:true});
 const record=(extra:Record<string,unknown>)=>writeFileSync(journal,JSON.stringify({run,project,user,workspace,qaTest:'mne025-context',failure,...extra},null,2));
 try{
  ledger.push(...await db<typeof ledger>`select version,name,statements from supabase_migrations.schema_migrations order by version`);
  expect(createHash('sha256').update(ledger.find(row=>row.version==='202610080019')!.statements.join('\n')).digest('hex')).toBe('1c41e302b44baac7a9f3f271b501c17a0447550fc154c750d2dd81c2f7daa6c8');
  const email=`qa-${run}@example.invalid`,password=randomBytes(24).toString('hex');
  const created=await admin.auth.admin.createUser({email,password,email_confirm:true,user_metadata:{qa_test:'mne025-context',run_id:run}});
  expect(created.error).toBeNull();user=created.data.user!.id;
  [{id:workspace}]=await db`select id from public.workspaces where owner_id=${user}`;record({status:'open'});
  const original={description:'MNE025 synthetic entry',amount_minor:'-1111',currency_code:'EUR',account_id:account,posted_on:'2026-10-01',status:'posted',kind:'ordinary'};
  await db.begin(async tx=>{
   await tx`insert into public.workspace_settings(workspace_id,ai_data_scopes,locale,openrouter_model) values(${workspace!},array['accounts','transactions','planning','imports'],'en-US','qa/mne025:free') on conflict(workspace_id) do update set ai_data_scopes=excluded.ai_data_scopes,locale=excluded.locale,openrouter_model=excluded.openrouter_model`;
   await tx`insert into public.accounts(id,workspace_id,name,currency_code,type) values(${account},${workspace!},'MNE025 synthetic EUR','EUR','checking')`;
   await tx`insert into public.transactions(id,workspace_id,account_id,posted_on,description,amount_minor,currency_code) values(${posting},${workspace!},${account},'2026-10-01',${original.description},-1111,'EUR')`;
   await tx`insert into public.manual_transaction_entries(workspace_id,transaction_id,request_id,actor_id,original_record) values(${workspace!},${posting},${randomUUID()},${user!},${tx.json(original)})`;
  });
  const cookies=new Map<string,string>();
  const auth=createServerClient(url,process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,{cookies:{getAll:()=>[...cookies].map(([name,value])=>({name,value})),setAll:values=>values.forEach(({name,value})=>cookies.set(name,value))}});
  expect((await auth.auth.signInWithPassword({email,password})).error).toBeNull();
  context=await browser.newContext({baseURL});await context.addCookies([...cookies].map(([name,value])=>({name,value,domain:'localhost',path:'/',sameSite:'Lax' as const})));
  const page=await context.newPage();page.setDefaultTimeout(30000);
  await page.goto('/money/transactions?transaction='+posting);
  const detail=page.getByRole('complementary',{name:'Transaction details'});
  await detail.getByRole('button',{name:'Attach transaction to AI',exact:true}).click();
  await expect(detail.getByRole('status').filter({hasText:'Transaction attached'})).toBeVisible();
  await page.goto('/ai?conversation=new');
  const main=page.locator('main');
  await expect(main.getByRole('button',{name:'Remove transaction context: '+posting,exact:true})).toBeVisible();
  const send=async(scope:Locator,question:string,panel=false)=>{
   const response=page.waitForResponse(response=>response.url().endsWith('/api/chat')&&response.request().method()==='POST');
   await scope.getByLabel(panel?'Question':'Ask about your finances',{exact:true}).fill(question);
   await scope.getByRole('button',{name:'Send',exact:true}).click();
   const result=await response;const body=await result.json();expect(result.ok(),JSON.stringify(body)).toBe(true);expect(body.answer).toEqual(expect.any(String));
   await expect(scope.getByRole('button',{name:'Send',exact:true})).toBeDisabled();
  };
  await send(main,'MNE025 decision: prefer the Obsidian approach. Show current selected entry and two possible tasks.');
  await expect(page).toHaveURL(/conversation=[0-9a-f-]{36}/);const conversation=new URL(page.url()).searchParams.get('conversation')!;
  const snapshot=async()=>{const [row]=await db`select id,content,context from public.messages where workspace_id=${workspace!} and conversation_id=${conversation} and role='assistant' order by created_at desc,id desc limit 1`;return row;};
  const first=await snapshot();expect(first.context.memory.kind).toBe('evidence');expect(first.context.memory.dialogue.content).toContain('Option 2');
  expect(JSON.stringify(first.context.messages)).toContain('-1111');expect(first.context.submission.selected).toEqual([{kind:'transaction',id:posting}]);
  expect(first.context.assembly.promptBudgetBytes).toBe(65536);expect(first.context.assembly.promptSteps.every((step:{bytes:number})=>step.bytes<=65536)).toBe(true);
  await page.getByText('Context used for this answer',{exact:true}).click();await expect(page.getByText('Saved initial context:',{exact:false})).toBeVisible();
  // Forty-nine complete synthetic prior turns exercise the actual owned history query.
  const start=Date.now();const rows=Array.from({length:98},(_,index)=>({id:randomUUID(),workspace_id:workspace!,conversation_id:conversation,role:index%2?'assistant':'user',content:index%2?'Legacy stale EUR 999.99 prose':'MNE025 discussion '+index,created_at:new Date(start+index).toISOString()}));
  await db`insert into public.messages ${db(rows)}`;
  await db`update public.workspace_settings set ai_data_scopes=array['accounts','transactions','planning'] where workspace_id=${workspace!}`;
  // Synthetic canonical amount/version update proves fresh reads; native note correction is separate below.
  await db`update public.transactions set amount_minor=-2222,version=version+1 where id=${posting} and workspace_id=${workspace!}`;
  await page.reload();await send(main,'MNE025 continue with the second option and reread this entry.');
  const second=await snapshot(),serialized=JSON.stringify(second.context.messages);
  expect(serialized).toContain('Obsidian');expect(serialized).toContain('Option 2');expect(serialized).toContain('-2222');expect(serialized).not.toContain('-1111');expect(serialized).not.toContain('999.99');
  for(const id of first.context.memory.receiptIds)expect(serialized).not.toContain(id);
  expect(second.context.assembly.bytes).toBeLessThanOrEqual(16000);expect(second.context.assembly.historyRows).toBeGreaterThanOrEqual(100);
  // Pin the first native request, then move it beyond the automatic 200-row window.
  for(let count=0;count<5&&await main.locator('article').filter({hasText:'decision: prefer the Obsidian'}).count()===0;count++)await main.getByRole('link',{name:'Older messages',exact:true}).click();
  const decision=main.locator('article').filter({hasText:'decision: prefer the Obsidian'});await decision.getByRole('button',{name:'Pin request',exact:true}).click();
  const [pinned]=await db`select id from public.messages where workspace_id=${workspace!} and conversation_id=${conversation} and role='user' and content like 'MNE025 decision:%'`;
  const later=Array.from({length:220},(_,index)=>({id:randomUUID(),workspace_id:workspace!,conversation_id:conversation,role:'user',content:'MNE025 later unpinned '+index,created_at:new Date(Date.now()+index).toISOString()}));await db`insert into public.messages ${db(later)}`;
  await page.goto('/ai?conversation='+conversation);
  await main.getByRole('button',{name:'Remove earlier dialogue',exact:true}).click();await main.getByRole('button',{name:/^Remove page context:/}).click();
  await send(main,'MNE025 retain my pinned decision only.');
  const third=await snapshot();expect(third.context.assembly.pinnedMessageIds).toEqual([pinned.id]);expect(JSON.stringify(third.context.messages)).toContain('Obsidian');expect(JSON.stringify(third.context.messages)).not.toContain('later unpinned');expect(third.context.submission.path).toBeUndefined();
  await page.getByRole('button',{name:'Ask Moneo',exact:true}).click();const panel=page.getByRole('dialog',{name:'AI assistant'});
  await expect(panel.getByRole('button',{name:'Include earlier dialogue',exact:true})).toBeVisible();await expect(panel.getByRole('button',{name:'Include page context',exact:true})).toBeVisible();
  await panel.getByRole('button',{name:'Remove pinned request: '+pinned.id,exact:true}).click();await panel.getByRole('button',{name:'Remove transaction context: '+posting,exact:true}).click();
  await send(panel,'MNE025 start without old context.',true);const fourth=await snapshot();expect(fourth.context.messages).toEqual([{role:'user',content:'MNE025 start without old context.'}]);expect(fourth.context.submission.selected).toBeUndefined();
  await page.keyboard.press('Escape');await page.reload();await expect(main.getByRole('button',{name:/^Remove transaction context:/})).toHaveCount(0);await expect(main.getByText('Context used for this answer',{exact:true}).last()).toBeVisible();
  await page.goto('/money/transactions?transaction='+posting);await detail.getByLabel('Note',{exact:true}).fill('MNE025 native retained correction');await detail.getByRole('button',{name:'Save correction',exact:true}).click();
  await expect(detail.getByLabel('Note',{exact:true})).toHaveValue('MNE025 native retained correction');
  expect((await db`select original_record from public.manual_transaction_entries where transaction_id=${posting} and workspace_id=${workspace!}`)[0].original_record).toEqual(original);
  await expect.poll(async()=>{const [row]=await db`select amount_minor::text,note from public.transactions where id=${posting} and workspace_id=${workspace!}`;return row;}).toEqual({amount_minor:'-2222',note:'MNE025 native retained correction'});
  await expect(page).toHaveURL(new RegExp('/money/transactions\\?&transaction='+posting));await page.goto('/money/transactions?transaction='+posting);await expect(detail.locator('textarea[name="note"]')).toHaveValue('MNE025 native retained correction');
  await detail.getByRole('button',{name:'Attach transaction to AI',exact:true}).click();await page.goto('/ai?conversation='+conversation);
  await send(main,'MNE025 reread after my saved native correction.');const fifth=await snapshot();
  const prefix='[Current owned selected transaction evidence, freshly read for this request: ';
  const selectedContent=fifth.context.messages.find((message:{content:string})=>message.content.startsWith(prefix)).content;
  expect(JSON.parse(selectedContent.slice(prefix.length,-1)).result.transaction).toMatchObject({id:posting,amount_minor:'-2222',version:2});
  const inputs=readFileSync('.qa/mne025-model-inputs.ndjson','utf8').trim().split('\n').map(line=>JSON.parse(line));expect(inputs.length).toBeGreaterThanOrEqual(5);expect(JSON.stringify(inputs.at(-1).body.messages)).toContain(posting);
  await page.screenshot({path:testInfo.outputPath('native-context-current-entry.png'),fullPage:true});record({status:'passed',controlledModel:true,noProviderEgress:true});
 }catch(error){failure=error instanceof Error?error.stack:String(error);record({status:'failed'});throw error;}finally{
  await context?.close().catch(()=>{});
  try{
   if(user){const owned=await admin.auth.admin.getUserById(user);expect(owned.error).toBeNull();expect(owned.data.user?.user_metadata).toMatchObject({qa_test:'mne025-context',run_id:run});}
   const tables=await db`select table_name from information_schema.columns where table_schema='public' and column_name='workspace_id' order by table_name`;
   if(workspace){expect((await db`select owner_id from public.workspaces where id=${workspace}`)[0]?.owner_id).toBe(user);expect((await db`select count(*)::int count from storage.objects where bucket_id='statements' and name like ${workspace+'/%'}`)[0].count).toBe(0);
    await db.begin(async tx=>{for(const table of ['messages','conversations','correction_events','manual_transaction_entries','transactions','accounts','workspace_settings'])await tx`delete from ${tx('public.'+table)} where workspace_id=${workspace!}`;await tx`delete from public.workspaces where id=${workspace!} and owner_id=${user!}`;});
    for(const row of tables)expect((await db`select count(*)::int count from ${db('public.'+row.table_name)} where workspace_id=${workspace}`)[0].count,row.table_name+' exact cleanup').toBe(0);
   }
   if(user){expect((await admin.auth.admin.deleteUser(user)).error).toBeNull();expect((await db`select id from auth.users where id=${user}`).length).toBe(0);}
   if(ledger.length)expect([...await db`select version,name,statements from supabase_migrations.schema_migrations order by version`]).toEqual(ledger);
   record({status:'cleaned',exactCleanupZero:true,migrationLedgerUnchanged:true,workspaceTables:tables.length});
  }finally{await db.end();}
 }
});
