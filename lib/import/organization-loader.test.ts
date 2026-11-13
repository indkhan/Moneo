import {expect,it} from 'vitest';
import type {SupabaseClient} from '@supabase/supabase-js';
import {loadOrganizationSuggestions} from '@/lib/import/organization-loader';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const entry=(n:number)=>({id:id(n),version:0,description:`CARD PAYMENT NORTHSTAR MARKET REF:${n}`,merchant_id:null,category_id:null,kind:'ordinary',review_reasons:[],posted_on:'2026-09-01',amount_minor:'-9007199254740993',currency_code:'EUR',status:'posted'});
function client(options:{corrected?:boolean|'ai';stale?:boolean;rulesError?:boolean;noRules?:boolean;historyBy?:string}={}){
 const calls:unknown[][]=[];
 const from=(table:string)=>{
  let selected:string[]|undefined;let recent=false;
  const q={select:()=>q,eq:(...args:unknown[])=>{calls.push([table,...args]);return q;},neq:()=>q,
   in:(_key:string,values:string[])=>{selected=values;return q;},order:(...args:unknown[])=>{calls.push([table,'order',...args]);return q;},limit:(n:number)=>{recent=true;calls.push([table,'limit',n]);return q;},
   then:(resolve:(v:unknown)=>unknown)=>resolve(table==='transactions'?{data:selected?[{...entry(4),version:options.stale?1:0}]:[1,2,3].map(n=>({...entry(n),merchant_id:id(20),category_id:id(21),organized_by:options.historyBy??null})),error:null}:
    table==='organization_rules'?{data:options.noRules?[]:[{id:id(30),version:2,description_key:'northstar market',merchant_id:id(22),category_id:id(23),approved_by:id(40),enabled:true}],error:options.rulesError?new Error('Rules unavailable'):null}:
    {data:options.corrected?[{transaction_id:id(4),origin:options.corrected===true?'owner':'ai'}]:[],error:null})};void recent;return q;
 };
 return {db:{from} as unknown as SupabaseClient,calls};
}
it('loads owned versioned rules and exact source history ahead of later learned suggestions',async()=>{
 const {db,calls}=client();const result=await loadOrganizationSuggestions(db,id(10),[{id:id(4),version:0}]);
 expect(result.proposals).toMatchObject([{transactionId:id(4),merchantId:id(22),categoryId:id(23),basis:'approved-rule',rule:{id:id(30),version:2}}]);
 expect(result.rows[0].amount_minor).toBe('-9007199254740993');
 for(const table of ['transactions','organization_rules','correction_events'])expect(calls).toContainEqual([table,'workspace_id',id(10)]);
 expect(calls).toContainEqual(['transactions','limit',2000]);
 expect(calls).toContainEqual(['transactions','order','posted_on',{ascending:false}]);
 expect(calls).toContainEqual(['transactions','order','id',{ascending:false}]);
});
it('suppresses later suggestions for retained user corrections and refuses stale or unavailable history',async()=>{
 expect((await loadOrganizationSuggestions(client({corrected:true}).db,id(10),[{id:id(4),version:0}])).proposals).toEqual([]);
 for(const options of [{stale:true},{rulesError:true}])await expect(loadOrganizationSuggestions(client(options).db,id(10),[{id:id(4),version:0}])).rejects.toThrow();
});
// The old auto-apply stored AI guesses as owner corrections, and its labelled rows then counted as "consistent history" for more guesses.
it('never treats AI labels as consistent history or AI-origin events as owner corrections',async()=>{
 const selection=[{id:id(4),version:0}];
 expect((await loadOrganizationSuggestions(client({noRules:true,historyBy:'owner'}).db,id(10),selection)).proposals).toMatchObject([{basis:'consistent-history',categoryId:id(21)}]);
 expect((await loadOrganizationSuggestions(client({noRules:true,historyBy:'ai'}).db,id(10),selection)).proposals).toMatchObject([{basis:'review-required',categoryId:null}]);
 expect((await loadOrganizationSuggestions(client({corrected:'ai'}).db,id(10),selection)).proposals).toMatchObject([{transactionId:id(4),basis:'approved-rule'}]);
});
