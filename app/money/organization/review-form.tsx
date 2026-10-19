'use client';
import {useActionState,useRef,useState} from 'react';
import {createReview,applyReview,undoReview} from './actions';
import {formatMoney} from '@/lib/finance/format';
import type {OrganizationProposal} from '@/lib/import/organization';

type Row={id:string;version:number;description:string;posted_on:string;amount_minor:string;currency_code:string};
type Target={id:string;name:string};
type Item={row:Row;proposal:OrganizationProposal};
const field='min-h-10 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground';
// Typed name -> [existing id | 'new' | 'keep', new name].
function choice(targets:Target[],name:string):[string,string]{
 const trimmed=name.trim();if(!trimmed)return ['keep',''];
 const found=targets.find(target=>target.name.toLowerCase()===trimmed.toLowerCase());
 return found?[found.id,'']:['new',trimmed];
}
export function OrganizationQueue({items,merchants,categories,requestId,locale}:{items:Item[];merchants:Target[];categories:Target[];requestId:string;locale:string}) {
 const [state,action,pending]=useActionState(createReview,{});
 const [selected,setSelected]=useState<string[]>([]);
 const [merchant,setMerchant]=useState('');
 const [category,setCategory]=useState('');
 const [assistance,setAssistance]=useState('');
 const [providerBusy,setProviderBusy]=useState(false);
 const draftRevision=useRef(0);
 const nameOf=(targets:Target[],id:string|null)=>id?targets.find(target=>target.id===id)?.name??'':'';
 const suggestion=(proposal:Pick<OrganizationProposal,'merchantId'|'merchantName'|'categoryId'>)=>[proposal.merchantName??nameOf(merchants,proposal.merchantId),nameOf(categories,proposal.categoryId)];
 const fill=(proposal:Pick<OrganizationProposal,'merchantId'|'merchantName'|'categoryId'>)=>{const [m,c]=suggestion(proposal);setMerchant(m);setCategory(c);};
 const rows=items.filter(item=>selected.includes(item.row.id)).map(({row:{id,version}})=>({id,version}));
 const [merchantValue,merchantName]=choice(merchants,merchant);
 const [categoryValue,categoryName]=choice(categories,category);
 const toggle=(ids:string[],on:boolean)=>{draftRevision.current++;setSelected(on?[...new Set([...selected,...ids])]:selected.filter(id=>!ids.includes(id)));};
 function applySuggestion(proposal:OrganizationProposal){
  const key=JSON.stringify(suggestion(proposal));draftRevision.current++;
  setSelected(items.filter(item=>JSON.stringify(suggestion(item.proposal))===key).map(item=>item.row.id));fill(proposal);
 }
 async function requestSuggestions(){
  const requestedRevision=draftRevision.current;
  setProviderBusy(true);setAssistance('');
  try{
   const response=await fetch('/api/money/organization/suggestions',{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(25000),body:JSON.stringify({rows,useProvider:true})});
   const body=await response.json() as {proposals?:OrganizationProposal[];providerStatus?:string;notice?:string};
   if(draftRevision.current!==requestedRevision){setAssistance('Your draft changed while suggestions were requested. Keep your choices or ask again.');return;}
   if(!response.ok||body.providerStatus!=='available'){setAssistance(body.notice??'AI suggestions are unavailable right now.');return;}
   const candidates=(body.proposals??[]).filter(candidate=>selected.includes(candidate.transactionId)&&candidate.basis==='provider-suggestion');
   const choices=new Set(candidates.map(candidate=>JSON.stringify([candidate.merchantId,candidate.merchantName,candidate.categoryId])));
   if(candidates.length&&candidates.length===selected.length&&choices.size===1){fill(candidates[0]);setAssistance('Filled from an AI suggestion. Check it in the preview before approving.');}
   else setAssistance(candidates.length?'AI suggestions differ across the selection. Select fewer entries.':'No AI suggestions were returned.');
  }catch{setAssistance('AI suggestions are unavailable right now.');}
  finally{setProviderBusy(false);}
 }
 const created=[categoryName&&`category “${categoryName}”`,merchantName&&`merchant “${merchantName}”`].filter(Boolean).join(' and ');
 return <form action={action} className="rounded-xl border border-border bg-card">
  <input type="hidden" name="rows" value={JSON.stringify(rows)} />
  <input type="hidden" name="requestId" value={requestId} />
  <input type="hidden" name="merchant" value={merchantValue} /><input type="hidden" name="merchantName" value={merchantName} />
  <input type="hidden" name="category" value={categoryValue} /><input type="hidden" name="categoryName" value={categoryName} />
  <div className="flex flex-wrap items-end gap-3 border-b border-border p-4">
   <label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={items.length>0&&selected.length===items.length} onChange={event=>toggle(items.map(item=>item.row.id),event.target.checked)} />{selected.length?`${selected.length} selected`:'Select all'}</label>
   <label className="grid gap-1 text-xs text-muted-foreground">Category<input name="categorySearch" list="organize-categories" value={category} onChange={event=>{draftRevision.current++;setCategory(event.target.value);}} maxLength={100} placeholder="Search or create" className={field} /></label>
   <label className="grid gap-1 text-xs text-muted-foreground">Merchant<input name="merchantSearch" list="organize-merchants" value={merchant} onChange={event=>{draftRevision.current++;setMerchant(event.target.value);}} maxLength={100} placeholder="Keep current" className={field} /></label>
   <datalist id="organize-categories">{categories.map(target=><option key={target.id} value={target.name} />)}</datalist>
   <datalist id="organize-merchants">{merchants.map(target=><option key={target.id} value={target.name} />)}</datalist>
   <button disabled={pending||providerBusy||!rows.length||(merchantValue==='keep'&&categoryValue==='keep')} className="min-h-10 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-40">{pending?'Preparing…':'Preview changes'}</button>
   <button type="button" disabled={providerBusy||pending||!rows.length} onClick={requestSuggestions} className="min-h-10 text-sm text-muted-foreground underline disabled:opacity-40">{providerBusy?'Asking AI…':'Suggest with AI'}</button>
   {created&&<p className="basis-full text-xs text-muted-foreground">New {created} will be created.</p>}
   {assistance&&<p role="status" className="basis-full text-sm">{assistance}</p>}
   {state.error&&<p role="alert" className="basis-full text-sm text-red-700 dark:text-red-300">{state.error}</p>}
  </div>
  <ul className="divide-y divide-border">{items.map(({row,proposal})=>{const hint=suggestion(proposal).filter(Boolean).join(' · ');
   return <li key={row.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
    <input type="checkbox" aria-label={'Select '+row.description} checked={selected.includes(row.id)} onChange={event=>toggle([row.id],event.target.checked)} />
    <span className="font-mono text-xs text-muted-foreground">{row.posted_on}</span>
    <a className="min-w-0 flex-1 truncate hover:underline" href={'/money/transactions?transaction='+row.id}>{row.description}</a>
    {proposal.financialReviewRequired&&<span className="text-xs text-muted-foreground">Check amount in Transactions</span>}
    {hint&&<button type="button" onClick={()=>applySuggestion(proposal)} title="Select similar entries and use this suggestion" className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground">{hint}</button>}
    <span className="font-mono">{formatMoney(row.amount_minor,row.currency_code,locale)}</span>
   </li>;})}</ul>
 </form>;
}
export function ApprovalForm({reviewId,canSaveRule}:{reviewId:string;canSaveRule:boolean}) {
 const [state,action,pending]=useActionState(applyReview,{});
 return <form action={action} className="mt-4 space-y-3">
  <input type="hidden" name="reviewId" value={reviewId} />
  <label className="flex gap-2 text-sm"><input type="checkbox" name="confirmed" value="true" required />I reviewed these entries and approve the changes.</label>
  {canSaveRule&&<label className="flex gap-2 text-sm"><input type="checkbox" name="saveRule" value="true" />Suggest the same for future entries with this description.</label>}
  {state.error&&<p role="alert" className="text-sm text-red-700 dark:text-red-300">{state.error}</p>}
  <button disabled={pending} className="min-h-10 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-40">{pending?'Applying…':'Approve'}</button>
 </form>;
}
export function UndoReviewForm({reviewId,rows}:{reviewId:string;rows:{id:string;version:number}[]}) {
 const [state,action,pending]=useActionState(undoReview,{});
 return <form action={action} className="mt-3"><input type="hidden" name="reviewId" value={reviewId} /><input type="hidden" name="rows" value={JSON.stringify(rows)} />
  {state.error&&<p role="alert" className="mb-2 text-sm text-red-700 dark:text-red-300">{state.error}</p>}
  <button disabled={pending} className="text-sm underline disabled:opacity-40">{pending?'Undoing…':'Undo this batch'}</button>
 </form>;
}
