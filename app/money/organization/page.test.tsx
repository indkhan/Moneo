import {beforeEach,expect,it,vi} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {requireWorkspace} from '@/lib/auth';
import {loadOrganizationSuggestions} from '@/lib/import-organization-loader';
import Page from './page';
vi.mock('@/lib/auth',()=>({requireWorkspace:vi.fn()}));
vi.mock('@/lib/import-organization-loader',()=>({loadOrganizationSuggestions:vi.fn()}));
vi.mock('./review-form',()=>({OrganizationGroup:({proposal}:{proposal:{descriptionKey:string}})=><article>{proposal.descriptionKey}</article>,ApprovalForm:()=> <p>Explicit approval required</p>}));
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const calls:unknown[][]=[];
const snapshots=[{id:id(1),version:0,description:'Northstar purchase',posted_on:'2026-09-01',amount_minor:'-9007199254740993',currency_code:'EUR'}];
function client({review=false,count=1}={}) {
 const from=(table:string)=>{
  let single=false;
  const q={select:()=>q,eq:(...args:unknown[])=>{calls.push([table,...args]);return q;},neq:()=>q,or:(...args:unknown[])=>{calls.push([table,'or',...args]);return q;},in:()=>q,
   order:()=>q,limit:()=>q,maybeSingle:()=>{single=true;return q;},then:(resolve:(v:unknown)=>unknown)=>resolve({data:table==='transactions'?Array.from({length:count},(_,n)=>({id:id(n+1),version:0,posted_on:'2026-09-01'})):
    table==='organization_reviews'?(single?(review?{id:id(30),snapshots,patch:{category_id:id(20)},merchant_name:'Northstar Market',rule_key:'northstar market',status:'pending'}:null):[]):table==='categories'?[{id:id(20),name:'Groceries'}]:[],error:null})};return q;
 };return {from};
}
beforeEach(()=>{vi.resetAllMocks();calls.length=0;vi.mocked(loadOrganizationSuggestions).mockResolvedValue({rows:snapshots,proposals:[{transactionId:id(1),version:0,descriptionKey:'northstar market',merchantName:'Northstar Market',merchantId:null,categoryId:null,basis:'review-required',financialReviewRequired:false,evidence:[]}],historyLimit:2000,historyCount:1} as never);});
it('renders persisted exact preview, explicit approval, coverage limits and manual fallback',async()=>{
 vi.mocked(requireWorkspace).mockResolvedValue({supabase:client({review:true}),workspace:{id:id(10),locale:'en-US',timezone:'UTC'}} as never);
 const html=renderToStaticMarkup(await Page({searchParams:Promise.resolve({review:id(30)})}));
 expect(html).toContain('Northstar purchase');expect(html).toContain('90071992547409.93');expect(html).toContain('Groceries');
 expect(html).toContain('Explicit approval required');expect(html).toContain('2,000 recent posted entries');expect(html).toContain('Manual correction in Transactions');
 for(const table of ['transactions','organization_reviews','organization_rules'])expect(calls).toContainEqual([table,'workspace_id',id(10)]);
});
it('paginates older unorganized history with a validated date/id cursor and retained import scope',async()=>{
 vi.mocked(requireWorkspace).mockResolvedValue({supabase:client({count:51}),workspace:{id:id(10),locale:'en-US',timezone:'UTC'}} as never);
 const html=renderToStaticMarkup(await Page({searchParams:Promise.resolve({import:id(40),cursor:'2026-09-02:'+id(80)})}));
 expect(html).toContain('Older entries needing organization');expect(html).toContain('import='+id(40));
 expect(calls).toContainEqual(['transactions','transaction_sources.source_transactions.import_id',id(40)]);
 expect(calls.some(call=>JSON.stringify(call).includes('posted_on.lt.2026-09-02'))).toBe(true);
});
