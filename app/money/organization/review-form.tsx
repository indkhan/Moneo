'use client';
import { Fragment,useActionState,useEffect,useRef,useState} from 'react';
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
/** Same-description entries together, newest first in each group, so one press can select a run of them. */
export function groupedByDescription<T extends { row: { description: string; posted_on: string } }>(items: T[]) {
  const groups = new Map<string, T[]>();
  for (const item of items) { const key = item.row.description.trim().toLocaleLowerCase("en"); groups.set(key, [...(groups.get(key) ?? []), item]); }
  return [...groups.values()].map(group => [...group].sort((a, b) => b.row.posted_on.localeCompare(a.row.posted_on)));
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
  setSelected([...new Set([...selected,...items.filter(item=>JSON.stringify(suggestion(item.proposal))===key).map(item=>item.row.id)])]);
  // Apply changes every selected row, so one chip must not retarget hand-picked rows it doesn't describe.
  if(items.some(item=>selected.includes(item.row.id)&&JSON.stringify(suggestion(item.proposal))!==key))setAssistance('Added to your selection. These entries have different suggestions, so choose the category and merchant yourself.');
  else{setAssistance('');fill(proposal);}
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
 const chosen=items.filter(item=>selected.includes(item.row.id));
 const keys=new Set(chosen.map(item=>item.proposal.descriptionKey));
 const ruleKey=keys.size===1&&[...keys][0].length>=3?[...keys][0]:null;
 const unchecked=chosen.filter(item=>item.proposal.financialReviewRequired).length;
 const similarCount=(proposal:OrganizationProposal)=>{const key=JSON.stringify(suggestion(proposal));return items.filter(item=>JSON.stringify(suggestion(item.proposal))===key).length;};
 const selectAll=useRef<HTMLInputElement>(null);
 useEffect(()=>{if(selectAll.current)selectAll.current.indeterminate=selected.length>0&&selected.length<items.length;},[selected.length,items.length]);
 const noTarget=merchantValue==='keep'&&categoryValue==='keep';
 const created=[categoryName&&`category “${categoryName}”`,merchantName&&`merchant “${merchantName}”`].filter(Boolean).join(' and ');
 return <form action={action} className="rounded-xl border border-border bg-card">
  <input type="hidden" name="rows" value={JSON.stringify(rows)} />
  <input type="hidden" name="requestId" value={requestId} />
  <input type="hidden" name="merchant" value={merchantValue} /><input type="hidden" name="merchantName" value={merchantName} />
  <input type="hidden" name="category" value={categoryValue} /><input type="hidden" name="categoryName" value={categoryName} />
  <div id="organize-controls" className="flex scroll-mt-24 flex-wrap items-end gap-3 border-b border-border p-4">
   <label className="flex min-h-10 items-center gap-2 text-sm"><input ref={selectAll} type="checkbox" checked={items.length>0&&selected.length===items.length} onChange={event=>toggle(items.map(item=>item.row.id),event.target.checked)} />{selected.length?`${selected.length} selected`:'Select all'}</label>
   <label className="grid gap-1 text-xs text-muted-foreground">Category<input name="categorySearch" list="organize-categories" value={category} onChange={event=>{draftRevision.current++;setCategory(event.target.value);}} maxLength={100} placeholder="Keep current, or type a name" className={field} /></label>
   <label className="grid gap-1 text-xs text-muted-foreground">Merchant<input name="merchantSearch" list="organize-merchants" value={merchant} onChange={event=>{draftRevision.current++;setMerchant(event.target.value);}} maxLength={100} placeholder="Keep current, or type a name" className={field} /></label>
   <datalist id="organize-categories">{categories.map(target=><option key={target.id} value={target.name} />)}</datalist>
   <datalist id="organize-merchants">{merchants.map(target=><option key={target.id} value={target.name} />)}</datalist>
   <button disabled={pending||providerBusy||!rows.length||noTarget} className="min-h-10 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-40">{pending?'Applying…':rows.length?`Apply to ${rows.length}`:'Apply'}</button>
   <label className={'flex min-h-10 items-center gap-2 text-sm'+(ruleKey?'':' text-muted-foreground')}><input type="checkbox" name="saveRule" value="true" disabled={!ruleKey} />{ruleKey?'Suggest the same for future entries like “'+ruleKey+'”':'Suggest the same for future entries (needs one description selected)'}</label>
   <button type="button" disabled={providerBusy||pending||!rows.length} onClick={requestSuggestions} className="min-h-10 text-sm text-muted-foreground underline disabled:opacity-40">{providerBusy?'Asking AI…':'Suggest with AI'}</button>
   {created&&<p className="basis-full text-xs text-muted-foreground">New {created} will be created. Capital letters don’t matter when matching an existing name.</p>}
   {unchecked>0&&<p className="basis-full text-xs text-warning">{unchecked} selected still {unchecked===1?'needs its':'need their'} amount checked. A category doesn’t confirm the amount.</p>}
   {assistance&&<p role="status" className="basis-full text-sm">{assistance}</p>}
   {state.error&&<p role="alert" className="basis-full text-sm text-danger">{state.error}{state.reviewId&&<> <a className="underline" href={'/money/organization?review='+state.reviewId}>Open the saved review</a></>}</p>}
   <p role="status" className="sr-only">{selected.length} selected</p>
  </div>
  <ul className="divide-y divide-border">{groupedByDescription(items).map(group=><Fragment key={group[0].row.id}>
   {group.length>1&&<li className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-muted/40 px-4 py-2.5 text-sm"><label className="flex min-h-10 min-w-0 items-center gap-3 font-medium"><input type="checkbox" checked={group.every(({row})=>selected.includes(row.id))} onChange={event=>toggle(group.map(({row})=>row.id),event.target.checked)} /><span className="min-w-0 break-words">{group[0].row.description}: all {group.length}</span></label><span className="font-mono text-xs text-muted-foreground">{group.at(-1)!.row.posted_on} to {group[0].row.posted_on}</span></li>}
   {group.map(({row,proposal})=>{const hint=suggestion(proposal).filter(Boolean).join(' · ');
   return <li key={row.id} className="flex items-start gap-3 px-4 py-3 text-sm">
    <label className="-m-2 flex size-10 shrink-0 items-center justify-center"><input type="checkbox" aria-label={'Select '+row.description+', '+row.posted_on+', '+formatMoney(row.amount_minor,row.currency_code,locale)} checked={selected.includes(row.id)} onChange={event=>toggle([row.id],event.target.checked)} /></label>
    <div className="min-w-0 flex-1 space-y-1">
     <a className="block break-words hover:underline" href={'/money/transactions?transaction='+row.id}>{row.description}</a>
     <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="font-mono text-xs text-muted-foreground">{row.posted_on}</span>
      {proposal.financialReviewRequired&&<a className="text-xs text-muted-foreground underline" href={'/money/transactions?transaction='+row.id}>Review its amount first</a>}
      {hint&&<button type="button" onClick={()=>applySuggestion(proposal)} className="min-h-8 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground">Select {similarCount(proposal)} like this: {hint}</button>}
     </div>
    </div>
    <span className="shrink-0 whitespace-nowrap font-mono">{formatMoney(row.amount_minor,row.currency_code,locale)}</span>
   </li>;})}</Fragment>)}</ul>
  {rows.length>0&&<div className="sticky bottom-20 z-10 max-lg:bottom-[calc(4rem+env(safe-area-inset-bottom))] flex flex-wrap items-center gap-3 rounded-b-xl border-t border-border bg-card p-3 shadow-lg md:bottom-4">
   <p className="text-sm font-medium">{rows.length} selected</p>
   {noTarget?<a className="text-sm underline" href="#organize-controls">Choose a category or merchant</a>:<p className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{[category,merchant].filter(Boolean).join(' · ')}</p>}
   <button disabled={pending||providerBusy||noTarget} className="ml-auto min-h-10 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-40">{pending?'Applying…':'Apply'}</button>
  </div>}
 </form>;
}
export function ApprovalForm({reviewId,canSaveRule}:{reviewId:string;canSaveRule:boolean}) {
 const [state,action,pending]=useActionState(applyReview,{});
 return <form action={action} className="mt-4 space-y-3">
  <input type="hidden" name="reviewId" value={reviewId} />
  <input type="hidden" name="confirmed" value="true" />
  {canSaveRule&&<label className="flex gap-2 text-sm"><input type="checkbox" name="saveRule" value="true" />Suggest the same for future entries with this description.</label>}
  {state.error&&<p role="alert" className="text-sm text-danger">{state.error}</p>}
  <button disabled={pending} className="min-h-10 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white disabled:opacity-40">{pending?'Applying…':'Apply'}</button>
 </form>;
}
export function UndoReviewForm({reviewId,rows}:{reviewId:string;rows:{id:string;version:number}[]}) {
 const [state,action,pending]=useActionState(undoReview,{});
 return <form action={action} className="mt-3"><input type="hidden" name="reviewId" value={reviewId} /><input type="hidden" name="rows" value={JSON.stringify(rows)} />
  {state.error&&<p role="alert" className="mb-2 text-sm text-danger">{state.error}</p>}
  <button disabled={pending} className="text-sm underline disabled:opacity-40">{pending?'Undoing…':'Undo this batch'}</button>
 </form>;
}
