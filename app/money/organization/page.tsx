import Link from 'next/link';
import {z} from 'zod';
import {requireWorkspace} from '@/lib/auth';
import {loadOrganizationSuggestions} from '@/lib/import/organization-loader';
import {MAX_ORGANIZATION_RULES,organizationDisplayName} from '@/lib/import/organization';
import {loadLoanPayoutIds} from '@/lib/finance/iou';
import {formatMoney} from '@/lib/finance/format';
import {versionedRows} from '../transactions/input';
import {dismissReview,toggleRule} from './actions';
import {OrganizationQueue,ApprovalForm,UndoReviewForm} from './review-form';

const snapshotSchema=z.object({id:z.uuid(),version:z.number().int().nonnegative(),description:z.string(),posted_on:z.iso.date(),amount_minor:z.string().regex(/^-?\d+$/),currency_code:z.string().regex(/^[A-Z]{3}$/),merchant_id:z.uuid().nullable(),category_id:z.uuid().nullable()}).passthrough();
export default async function OrganizationPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {
 const {supabase,workspace}=await requireWorkspace();const params=await searchParams;
 const reviewId=params.review===undefined?null:z.uuid().parse(params.review);
 const importId=params.import===undefined?null:z.uuid().parse(params.import);
 let cursor:{date:string;id:string}|null=null;
 if(params.cursor){const parts=z.string().parse(params.cursor).split(':');if(parts.length!==2)throw new Error('Invalid organization cursor');cursor={date:z.iso.date().parse(parts[0]),id:z.uuid().parse(parts[1])};}
 let query=supabase.from('transactions').select(importId?'id,version,posted_on,transaction_sources!inner(source_transactions!inner(import_id))':'id,version,posted_on').eq('workspace_id',workspace.id).neq('status','voided').neq('kind','transfer');
 query=query.or(cursor?`and(or(merchant_id.is.null,category_id.is.null),or(posted_on.lt.${cursor.date},and(posted_on.eq.${cursor.date},id.lt.${cursor.id})))`:'merchant_id.is.null,category_id.is.null');
 if(importId)query=query.eq('transaction_sources.source_transactions.import_id',importId);
 // A loan's payout is recorded in Wealth; it is not spending to organize.
 const loans=await loadLoanPayoutIds(supabase,workspace.id).catch(()=>new Set<string>());
 if(loans.size)query=query.not('id','in',`(${[...loans].join(',')})`);
 const [queue,merchants,categories,rules,reviews,selectedReview]=await Promise.all([
  query.order('posted_on',{ascending:false}).order('id',{ascending:false}).limit(51),
  supabase.from('merchants').select('id,name').eq('workspace_id',workspace.id).order('name').limit(501),
  supabase.from('categories').select('id,name').eq('workspace_id',workspace.id).order('name').limit(501),
  supabase.from('organization_rules').select('id,description_key,merchant_id,category_id,enabled,version').eq('workspace_id',workspace.id).order('description_key').limit(MAX_ORGANIZATION_RULES+1),
  supabase.from('organization_reviews').select('id,status,created_at').eq('workspace_id',workspace.id).order('created_at',{ascending:false}).order('id',{ascending:false}).limit(10),
  reviewId?supabase.from('organization_reviews').select('*').eq('workspace_id',workspace.id).eq('id',reviewId).maybeSingle():{data:null,error:null},
 ]);
 if(queue.error||merchants.error||categories.error||rules.error||reviews.error||selectedReview.error)throw queue.error??merchants.error??categories.error??rules.error??reviews.error??selectedReview.error;
 const queueRows=z.array(z.object({id:z.uuid(),version:z.number().int().nonnegative(),posted_on:z.iso.date()})).parse(queue.data);
 if(merchants.data.length>500||categories.data.length>500||rules.data.length>MAX_ORGANIZATION_RULES)throw new Error('Organization target coverage exceeded; use Transactions for manual correction');
 const selected=queueRows.slice(0,50).map(({id,version})=>({id,version}));
 const suggestions=selected.length?await loadOrganizationSuggestions(supabase,workspace.id,selected):null;
 const items=(suggestions?.proposals??[]).map(proposal=>({proposal,row:suggestions!.rows.find(row=>row.id===proposal.transactionId)!}));
 const review=selectedReview.data;
 const snapshots=review?z.array(snapshotSchema).max(50).parse(review.snapshots):[];
 const [batch,currentRows]=await Promise.all([
  review?.batch_id?supabase.from('transaction_batches').select('undone').eq('workspace_id',workspace.id).eq('id',review.batch_id).maybeSingle():{data:null,error:null},
  review?.batch_id?supabase.from('transactions').select('id,version').eq('workspace_id',workspace.id).in('id',snapshots.map(row=>row.id)):{data:[],error:null},
 ]);
 if(batch.error||currentRows.error)throw batch.error??currentRows.error;
 const merchantName=(id:unknown)=>id?merchants.data.find(row=>row.id===id)?.name??'a removed merchant':null;
 const categoryName=(id:unknown)=>id?categories.data.find(row=>row.id===id)?.name??'a removed category':null;
 const reviewStatus:Record<string,string>={pending:'Waiting for approval',applied:'Applied',dismissed:'Dismissed'};
 const totals:Record<string,string>={};for(const row of snapshots)totals[row.currency_code]=(BigInt(totals[row.currency_code]??'0')+BigInt(row.amount_minor)).toString();
 const last=queueRows[49],next=queueRows.length>50&&last?new URLSearchParams({...importId?{import:importId}:{},cursor:last.posted_on+':'+last.id}).toString():null;
 const patchMerchant=review?(review.merchant_name??(Object.hasOwn(review.patch,'merchant_id')?merchantName(review.patch.merchant_id)??'no merchant':undefined)):undefined;
 const patchCategory=review&&Object.hasOwn(review.patch,'category_id')?categoryName(review.patch.category_id)??'uncategorized':undefined;
 const card='rounded-xl border border-border bg-card p-6';
 // A rule shows the payee's cleaned name, not the bank text it matches; the full key stays in the tooltip.
 const ruleItem=(rule:typeof rules.data[number])=><li key={rule.id} className="flex flex-wrap items-center justify-between gap-2 py-2"><span className={rule.enabled?'':'text-muted-foreground'}><span className="font-medium" title={rule.description_key}>{merchantName(rule.merchant_id)??organizationDisplayName(rule.description_key)}</span> → {categoryName(rule.category_id)??'no category'}</span><form action={toggleRule}><input type="hidden" name="key" value={rule.description_key} /><input type="hidden" name="merchant" value={rule.merchant_id??''} /><input type="hidden" name="category" value={rule.category_id??''} /><input type="hidden" name="version" value={rule.version} /><input type="hidden" name="enabled" value={String(!rule.enabled)} /><button className="text-xs underline">{rule.enabled?'Disable':'Enable'}</button></form></li>;
 return <main className="mx-auto w-full max-w-[1400px] space-y-6 px-4 py-6 text-foreground sm:px-8 lg:py-8">
  <header><p className="eyebrow">Money</p><h1 className="mt-1 page-title">Organize spending</h1>
   <p className="mt-2 text-sm text-muted-foreground">Tick entries, pick a category, press Apply. Every batch can be undone.</p></header>
  {reviewId&&!review&&<p role="alert" className="text-sm">This review is no longer available.</p>}
  {review&&<section aria-label="Organization impact preview" className={card}>
   <h2 className="text-sm font-medium">{batch.data?.undone?'Undone':review.status==='applied'?'Applied':review.status==='dismissed'?'Dismissed':'Not applied yet'}{patchCategory&&` · ${patchCategory}`}{patchMerchant&&` · ${patchMerchant}`}</h2>
   <details className="mt-1 text-sm"><summary className="cursor-pointer text-muted-foreground hover:text-foreground">{snapshots.length} {snapshots.length===1?'entry':'entries'} · Total {Object.entries(totals).map(([currency,minor])=>formatMoney(minor,currency,workspace.locale)).join('; ')}</summary>
   <ul className="mt-3 divide-y divide-border text-sm">{snapshots.map(row=>{
    const beforeMerchant=merchantName(row.merchant_id)??'unassigned';
    const beforeCategory=categoryName(row.category_id)??'uncategorized';
    return <li key={row.id} className="flex flex-wrap items-baseline gap-x-3 py-2"><span className="font-mono text-xs text-muted-foreground">{row.posted_on}</span><Link className="min-w-0 flex-1 truncate hover:underline" href={'/money/transactions?transaction='+row.id}>{row.description}</Link><span className="font-mono">{formatMoney(row.amount_minor,row.currency_code,workspace.locale)}</span>
     <span className="basis-full text-xs text-muted-foreground">{`Merchant: ${beforeMerchant} → ${patchMerchant??beforeMerchant}`} · {`Category: ${beforeCategory} → ${patchCategory??beforeCategory}`}</span></li>;
   })}</ul></details>
   {review.status==='pending'&&<><ApprovalForm reviewId={review.id} canSaveRule={Boolean(review.rule_key)} /><form action={dismissReview} className="mt-3"><input type="hidden" name="reviewId" value={review.id} /><button className="text-sm text-muted-foreground underline">Dismiss</button></form></>}
   {review.batch_id&&!batch.data?.undone&&currentRows.data.length===snapshots.length&&<UndoReviewForm reviewId={review.id} rows={versionedRows.parse(currentRows.data)} />}
  </section>}
  <section aria-label="Organization suggestions" className="space-y-3">
   <h2 className="text-sm font-medium">{items.length?`${items.length}${queueRows.length>50?'+':''} to organize`:'Everything here is organized'}</h2>
   {items.length>0&&<OrganizationQueue key={items.map(item=>item.row.id+':'+item.row.version).join(',')} items={items} merchants={merchants.data} categories={categories.data} requestId={crypto.randomUUID()} locale={workspace.locale} />}
   {next&&<Link className="inline-block text-sm underline" href={'/money/organization?'+next}>Older entries</Link>}
   <p className="text-xs text-muted-foreground">Suggestions compare up to 2,000 recent posted entries and 2,000 rules. For one-off fixes use <Link className="underline" href="/money/transactions">Manual correction in Transactions</Link>.</p>
  </section>
  <details className={card}><summary className="cursor-pointer text-sm font-medium">Rules ({rules.data.filter(rule=>rule.enabled).length}) and recent reviews</summary>
   <ul className="mt-3 divide-y divide-border text-sm">{rules.data.filter(rule=>rule.enabled).map(ruleItem)}</ul>
   {rules.data.some(rule=>!rule.enabled)&&<details className="mt-2"><summary className="cursor-pointer text-sm text-muted-foreground">Disabled ({rules.data.filter(rule=>!rule.enabled).length})</summary>
    <ul className="mt-2 divide-y divide-border text-sm">{rules.data.filter(rule=>!rule.enabled).map(ruleItem)}</ul></details>}
   {!rules.data.length&&<p className="mt-2 text-sm text-muted-foreground">No rules yet.</p>}
   <ul className="mt-3 space-y-1 border-t border-border pt-3 text-sm">{reviews.data.map(row=><li key={row.id}><Link className="underline" href={'/money/organization?review='+row.id}>{reviewStatus[row.status]??row.status} · {new Date(row.created_at).toLocaleString(workspace.locale,{timeZone:workspace.timezone})}</Link></li>)}</ul>
   {!reviews.data.length&&<p className="mt-2 text-sm text-muted-foreground">No reviews yet.</p>}
  </details>
 </main>;
}
