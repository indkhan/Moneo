import {afterEach,beforeEach,expect,it,vi} from 'vitest';
const state=vi.hoisted(()=>({mode:'startup',clients:[] as {end:ReturnType<typeof vi.fn>}[]}));
vi.mock('postgres',()=>({default:()=>{
  let reads=0;
  const db=Object.assign(vi.fn(async()=>{
    if(state.mode==='startup' || reads++>0)throw new Error('Injected ledger or cleanup read failure');
    return [];
  }),{end:vi.fn(async()=>{}),begin:vi.fn(async()=>{throw new Error('Injected fixture failure');}),unsafe:vi.fn(async()=>{throw new Error('Injected private-schema cleanup failure');})});
  state.clients.push(db);return db;
}}));
vi.mock('node:fs',async importOriginal=>({...await importOriginal<typeof import('node:fs')>(),
  mkdirSync:vi.fn(),writeFileSync:vi.fn(),unlinkSync:vi.fn(),existsSync:vi.fn(()=>false)}));
beforeEach(()=>{
  vi.resetModules();vi.clearAllMocks();state.clients=[];
  vi.spyOn(process,'loadEnvFile').mockImplementation(()=>{});
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','https://synthetic.supabase.co');
  vi.stubEnv('SUPABASE_DB_URL','postgres://db.synthetic.supabase.co/postgres');
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();});
const runners={throughput:()=>import('../supabase/tests/import-batch-throughput.mjs'),
  concurrency:()=>import('../supabase/tests/import-batch-concurrency.mjs'),proxy:()=>import('../supabase/tests/import-batch-proxy.mjs')};
for(const [name,load] of Object.entries(runners))for(const mode of ['startup','cleanup'])it(`${name} closes every database handle after a ${mode} failure and retains recovery evidence`,async()=>{
  state.mode=mode;
  await expect(load()).rejects.toThrow();
  expect(state.clients.length).toBe(name==='concurrency'?4:1);
  for(const db of state.clients)expect(db.end).toHaveBeenCalledOnce();
  const fs=await import('node:fs');expect(fs.unlinkSync).not.toHaveBeenCalled();
});
