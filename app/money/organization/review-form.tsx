'use client';
import {useActionState,useRef,useState} from 'react';
import {createReview,applyReview,undoReview} from './actions';
import {formatMoney} from '@/lib/finance/format';
import type {OrganizationProposal} from '@/lib/import-organization';

type Row={id:string;version:number;description:string;posted_on:string;amount_minor:string;currency_code:string};
type Target={id:string;name:string};
export function OrganizationGroup({rows,proposal,merchants,categories,requestId,locale}:{rows:Row[];proposal:OrganizationProposal;merchants:Target[];categories:Target[];requestId:string;locale:string}) {
 const [state,action,pending]=useActionState(createReview,{});
 const [selected,setSelected]=useState(rows.map(row=>row.id));
 const [merchant,setMerchant]=useState(proposal.merchantId??(proposal.merchantName?'new':'keep'));
 const [merchantName,setMerchantName]=useState(proposal.merchantName??'');
 const [category,setCategory]=useState(proposal.categoryId??'keep');
 const [assistance,setAssistance]=useState('');
 const [providerBusy,setProviderBusy]=useState(false);
 const [providerProposals,setProviderProposals]=useState<OrganizationProposal[]>([]);
 const draftRevision=useRef(0);
 async function requestSuggestions(){
  const requestedRevision=draftRevision.current;
  setProviderBusy(true);setAssistance('');setProviderProposals([]);
  try{
   const response=await fetch('/api/money/organization/suggestions',{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(25000),
    body:JSON.stringify({rows:rows.filter(row=>selected.includes(row.id)).map(({id,version})=>({id,version})),useProvider:true})});
   const body=await response.json() as {proposals?:OrganizationProposal[];providerStatus?:string;notice?:string};
   if(draftRevision.current!==requestedRevision){setAssistance('Your draft changed while suggestions were requested. Keep your current choices or request fresh suggestions.');return;}
   if(!response.ok||body.providerStatus!=='available'){setAssistance(body.notice??'Optional suggestions unavailable. Keep using the manual choices below.');return;}
   const candidates=(body.proposals??[]).filter(candidate=>selected.includes(candidate.transactionId)&&candidate.basis==='provider-suggestion');setProviderProposals(candidates);
   if(!candidates.length){setAssistance('No attributable AI suggestions were returned. Keep using the source/history suggestions and manual choices.');return;}
   const choices=new Set(candidates.map(candidate=>JSON.stringify([candidate.merchantId,candidate.merchantName,candidate.categoryId])));
   if(candidates.length===selected.length&&choices.size===1){
    const candidate=candidates[0];setMerchant(candidate.merchantId??(candidate.merchantName?'new':'keep'));setMerchantName(candidate.merchantName??'');setCategory(candidate.categoryId??'keep');
    setAssistance('Optional suggestions filled the draft choices. Review their evidence and the exact preview before approving.');
   }else setAssistance('Suggestions differ across these entries. Select one entry to review its suggestion, or use the manual choices.');
  }catch{setAssistance('Optional suggestions unavailable. Keep using the manual choices below.');}
  finally{setProviderBusy(false);}
 }
 return <article className="rounded-xl border border-border bg-card p-4">
  <h2 className="font-semibold">{proposal.descriptionKey||'Unrecognized description'}</h2>
  <p className="mt-1 text-sm text-muted-foreground">{proposal.basis==='approved-rule'?'Your approved rule':proposal.basis==='consistent-history'?`${proposal.evidence.length} consistent historical entries`:'Review required: description-derived merchant; choose a category.'} Suggestions require approval; evidence counts are not probabilities.</p>
  {proposal.financialReviewRequired&&<p className="mt-2 text-sm font-medium">Financial interpretation needs separate review in Transactions. Organization changes only merchant/category metadata.</p>}
  {proposal.evidence.length>0&&<details className="mt-2 text-xs"><summary>Source evidence ({proposal.evidence.length} entries)</summary><ul>{proposal.evidence.map(row=><li key={row.id}><a className="underline" href={'/money/transactions?transaction='+row.id}>Entry {row.id.slice(0,8)}</a> · reviewed version {row.version}</li>)}</ul></details>}
  <form action={action} className="mt-3 space-y-3">
   <input type="hidden" name="rows" value={JSON.stringify(rows.filter(row=>selected.includes(row.id)).map(({id,version})=>({id,version})))} />
   <input type="hidden" name="requestId" value={requestId} />
   <ul className="space-y-1">{rows.map(row=><li key={row.id}><label className="flex gap-2 text-sm"><input type="checkbox" checked={selected.includes(row.id)} onChange={event=>{draftRevision.current++;setSelected(event.target.checked?[...selected,row.id]:selected.filter(id=>id!==row.id));}} /><span>{row.posted_on} · {row.description} · {formatMoney(row.amount_minor,row.currency_code,locale)}</span></label></li>)}</ul>
   <div className="flex flex-wrap gap-3">
    <label className="grid gap-1 text-sm">Merchant<select name="merchant" value={merchant} onChange={event=>{draftRevision.current++;setMerchant(event.target.value);}} className="rounded border bg-card p-2"><option value="keep">Keep current merchants</option><option value="">Clear merchant</option><option value="new">Review a merchant name</option>{merchants.map(target=><option key={target.id} value={target.id}>{target.name}</option>)}</select></label>
    {merchant==='new'&&<label className="grid gap-1 text-sm">Merchant name<input name="merchantName" required maxLength={100} value={merchantName} onChange={event=>{draftRevision.current++;setMerchantName(event.target.value);}} className="rounded border bg-card p-2" /></label>}
    <label className="grid gap-1 text-sm">Category<select name="category" value={category} onChange={event=>{draftRevision.current++;setCategory(event.target.value);}} className="rounded border bg-card p-2"><option value="keep">Keep current categories</option><option value="">Uncategorized</option>{categories.map(target=><option key={target.id} value={target.id}>{target.name}</option>)}</select></label>
   </div>
   <button type="button" disabled={providerBusy||pending||!selected.length} onClick={requestSuggestions} className="text-sm underline disabled:opacity-40">{providerBusy?'Requesting optional suggestions…':'Request optional AI suggestions'}</button>
   {assistance&&<p role="status" className="text-sm">{assistance}</p>}
   {providerProposals.length>0&&<ul className="space-y-1 text-xs">{providerProposals.map(candidate=><li key={candidate.transactionId}>{rows.find(row=>row.id===candidate.transactionId)?.description}: {candidate.merchantName??merchants.find(target=>target.id===candidate.merchantId)?.name??'keep merchant'} · {categories.find(target=>target.id===candidate.categoryId)?.name??'keep category'}{candidate.evidenceQuote&&<> · Source quote: “{candidate.evidenceQuote}”</>}</li>)}</ul>}
   {state.error&&<p role="alert" className="text-sm text-red-700 dark:text-red-300">{state.error}</p>}
   <button disabled={pending||providerBusy||!selected.length} className="rounded bg-brand px-3 py-2 text-sm font-medium text-white disabled:opacity-40">{pending?'Preparing review…':`Preview ${selected.length} entries`}</button>
  </form>
 </article>;
}
export function ApprovalForm({reviewId,canSaveRule}:{reviewId:string;canSaveRule:boolean}) {
 const [state,action,pending]=useActionState(applyReview,{});
 return <form action={action} className="mt-4 space-y-3">
  <input type="hidden" name="reviewId" value={reviewId} />
  <label className="flex gap-2 text-sm"><input type="checkbox" name="confirmed" value="true" required />I reviewed these exact entries and approve the merchant/category changes.</label>
  {canSaveRule&&<label className="flex gap-2 text-sm"><input type="checkbox" name="saveRule" value="true" />Save an approved rule for this description. Later suggestions will respect it; retained corrections take precedence.</label>}
  {state.error&&<p role="alert" className="text-sm text-red-700 dark:text-red-300">{state.error}</p>}
  <button disabled={pending} className="rounded bg-brand px-3 py-2 text-sm font-medium text-white disabled:opacity-40">{pending?'Applying…':'Approve organization'}</button>
 </form>;
}
export function UndoReviewForm({reviewId,rows}:{reviewId:string;rows:{id:string;version:number}[]}) {
 const [state,action,pending]=useActionState(undoReview,{});
 return <form action={action} className="mt-3"><input type="hidden" name="reviewId" value={reviewId} /><input type="hidden" name="rows" value={JSON.stringify(rows)} />
  {state.error&&<p role="alert" className="mb-2 text-sm text-red-700 dark:text-red-300">{state.error}</p>}
  <button disabled={pending} className="text-sm underline disabled:opacity-40">{pending?'Undoing…':'Undo organization batch and its saved rule'}</button>
 </form>;
}
