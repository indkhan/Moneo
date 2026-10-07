import {expect,it} from 'vitest';
import type {SupabaseClient} from '@supabase/supabase-js';
import {loadOrganizationPreview} from './import-organization-preview';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const rows=[{id:id(1),version:4,description:'Noisy Northstar ref:777',posted_on:'2026-09-01',amount_minor:'-9007199254740993',currency_code:'EUR',merchant_id:null,category_id:null},
  {id:id(2),version:2,description:'Noisy Northstar ref:888',posted_on:'2026-09-02',amount_minor:'-300',currency_code:'JPY',merchant_id:id(5),category_id:id(6)}];
function client(options:{missingTarget?:boolean;changed?:boolean;missingRow?:boolean}={}) {
  const calls:unknown[][]=[];
  const from=(table:string)=>{
    const q={select:()=>q,eq:(...args:unknown[])=>{calls.push([table,...args]);return q;},neq:()=>q,
      in:async()=>({data:options.missingRow?rows.slice(0,1):rows.map(row=>({...row,version:options.changed?99:row.version})),error:null}),
      maybeSingle:async()=>({data:options.missingTarget?null:{id:table==='categories'?id(3):id(4),name:table==='categories'?'Food':'Northstar'},error:null})};return q;
  };
  return {db:{from} as unknown as SupabaseClient,calls};
}
const input={rows:rows.map(({id,version})=>({id,version})),categoryId:id(3),merchantId:id(4)};
it('previews exact versioned history and separate currency totals without writing financial fields',async()=>{
  const {db,calls}=client();
  const result=await loadOrganizationPreview(db,id(10),input);
  expect(result.rows).toEqual(rows);
  expect(result.totals).toEqual({EUR:'-9007199254740993',JPY:'-300'});
  expect(result.patch).toEqual({category_id:id(3),merchant_id:id(4)});
  expect(result.targets).toMatchObject({category:{name:'Food'},merchant:{name:'Northstar'}});
  for(const table of ['transactions','categories','merchants'])expect(calls).toContainEqual([table,'workspace_id',id(10)]);
  expect(result.patch).not.toHaveProperty('amount_minor');
  expect(result.patch).not.toHaveProperty('kind');
});
it('refuses a changed or incomplete selection and unavailable owned targets',async()=>{
  for(const options of [{changed:true},{missingRow:true},{missingTarget:true}])await expect(loadOrganizationPreview(client(options).db,id(10),input)).rejects.toThrow();
});
it('rejects duplicate targets, unbounded input and financial mutation fields before reading',async()=>{
  const {db,calls}=client();
  for(const invalid of [{...input,rows:[input.rows[0],input.rows[0]]},{...input,rows:Array.from({length:51},(_,n)=>({id:id(n+50),version:0}))},{...input,amountMinor:'999'}, {rows:input.rows}])
    await expect(loadOrganizationPreview(db,id(10),invalid)).rejects.toThrow();
  expect(calls).toEqual([]);
});
