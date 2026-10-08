import Link from 'next/link';
import {z} from 'zod';
import {requireWorkspace} from '@/lib/auth';
import {loadOrganizationSuggestions} from '@/lib/import-organization-loader';
import {formatMoney} from '@/lib/finance/format';
import {versionedRows} from '../transactions/input';
import {dismissReview,toggleRule} from './actions';
import {OrganizationGroup,ApprovalForm,UndoReviewForm} from './review-form';

const snapshotSchema=z.object({id:z.uuid(),version:z.number().int().nonnegative(),description:z.string(),posted_on:z.iso.date(),amount_minor:z.string().regex(/^-?\d+$/),currency_code:z.string().regex(/^[A-Z]{3}$/),merchant_id:z.uuid().nullable(),category_id:z.uuid().nullable()}).passthrough();
export default async function OrganizationPage({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {
 const {supabase,workspace}=await requireWorkspace();const params=await searchParams;
 const reviewId=params.review===undefined?null:z.uuid().parse(params.review);
 const importId=params.import===undefined?null:z.uuid().parse(params.import);
 let cursor:{date:string;id:string}|null=null;
 if(params.cursor){const parts=z.string().parse(params.cursor).split(':');if(parts.length!==2)throw new Error('Invalid organization cursor');cursor={date:z.iso.date().parse(parts[0]),id:z.uuid().parse(parts[1])};}
 let query=supabase.from('transactions').select(importId?'id,version,posted_on,transaction_sources!inner(source_transactions!inner(import_id))':'id,version,posted_on').eq('workspace_id',workspace.id).neq('status','voided');
 query=query.or(cursor?`and(or(merchant_id.is.null,category_id.is.null),or(posted_on.lt.${cursor.date},and(posted_on.eq.${cursor.date},id.lt.${cursor.id})))`:'merchant_id.is.null,category_id.is.null');
 if(importId)query=query.eq('transaction_sources.source_transactions.import_id',importId);
 const [queue,merchants,categories,rules,reviews,selectedReview]=await Promise.all([
  query.order('posted_on',{ascending:false}).order('id',{ascending:false}).limit(51),
  supabase.from('merchants').select('id,name').eq('workspace_id',workspace.id).order('name').limit(501),
  supabase.from('categories').select('id,name').eq('workspace_id',workspace.id).order('name').limit(501),
  supabase.from('organization_rules').select('id,description_key,merchant_id,category_id,enabled,version').eq('workspace_id',workspace.id).order('description_key').limit(201),
  supabase.from('organization_reviews').select('id,status,created_at').eq('workspace_id',workspace.id).order('created_at',{ascending:false}).order('id',{ascending:false}).limit(10),
  reviewId?supabase.from('organization_reviews').select('*').eq('workspace_id',workspace.id).eq('id',reviewId).maybeSingle():{data:null,error:null},
 ]);
 if(queue.error||merchants.error||categories.error||rules.error||reviews.error||selectedReview.error)throw queue.error??merchants.error??categories.error??rules.error??reviews.error??selectedReview.error;
 const queueRows=z.array(z.object({id:z.uuid(),version:z.number().int().nonnegative(),posted_on:z.iso.date()})).parse(queue.data);
 if(merchants.data.length>500||categories.data.length>500||rules.data.length>200)throw new Error('Organization target coverage exceeded; use Transactions for manual correction');
 const selected=queueRows.slice(0,50).map(({id,version})=>({id,version}));
 const suggestions=selected.length?await loadOrganizationSuggestions(supabase,workspace.id,selected):null;
 const groups=new Map<string,{proposal:NonNullable<typeof suggestions>['proposals'][number];rows:NonNullable<typeof suggestions>['rows']}>();
 for(const proposal of suggestions?.proposals??[]){
  const key=JSON.stringify([proposal.descriptionKey,proposal.merchantId,proposal.categoryId,proposal.merchantName,proposal.basis]);
  const group=groups.get(key)??{proposal:{...proposal},rows:[]};group.rows.push(suggestions!.rows.find(row=>row.id===proposal.transactionId)!);
  group.proposal.financialReviewRequired ||=proposal.financialReviewRequired;groups.set(key,group);
 }
 const review=selectedReview.data;
 const snapshots=review?z.array(snapshotSchema).max(50).parse(review.snapshots):[];
 const batch=review?.batch_id?await supabase.from('transaction_batches').select('undone').eq('workspace_id',workspace.id).eq('id',review.batch_id).maybeSingle():{data:null,error:null};
 if(batch.error)throw batch.error;
 const currentRows=review?.batch_id?await supabase.from('transactions').select('id,version').eq('workspace_id',workspace.id).in('id',snapshots.map(row=>row.id)):{data:[],error:null};
 if(currentRows.error)throw currentRows.error;
 const totals:Record<string,string>={};for(const row of snapshots)totals[row.currency_code]=(BigInt(totals[row.currency_code]??'0')+BigInt(row.amount_minor)).toString();
 const last=queueRows[49],next=queueRows.length>50&&last?new URLSearchParams({...importId?{import:importId}:{},cursor:last.posted_on+':'+last.id}).toString():null;
 return <main className="mx-auto max-w-6xl space-y-6 px-4 py-6 text-foreground sm:px-8">
  <header className="flex flex-wrap justify-between gap-3"><div><h1 className="text-3xl font-semibold">Organize imported spending</h1><p className="mt-2 text-sm text-muted-foreground">Review merchant/category suggestions, preserve corrections, and reuse approved rules.</p></div><div className="flex gap-3 text-sm"><Link className="underline" href="/money/transactions">Manual correction in Transactions</Link><Link className="underline" href="/import">Import statement</Link></div></header>
  {reviewId&&!review&&<p role="alert">This owned review is unavailable. Create a fresh preview below.</p>}
  {review&&<section aria-label="Organization impact preview" className="rounded-xl border border-border bg-card p-5">
   <h2 className="text-xl font-semibold">{batch.data?.undone?'Undone organization':review.status==='applied'?'Applied organization':review.status==='dismissed'?'Dismissed review':'Review exact changes'}</h2>
   <p className="mt-2 text-sm">{snapshots.length} affected entries. Merchant: {review.merchant_name??(Object.hasOwn(review.patch,'merchant_id')?(merchants.data.find(row=>row.id===review.patch.merchant_id)?.name??'clear'):'keep current')}. Category: {Object.hasOwn(review.patch,'category_id')?(categories.data.find(row=>row.id===review.patch.category_id)?.name??'uncategorized'):'keep current'}.</p>
   <ul className="mt-3 space-y-2 text-sm">{snapshots.map(row=>{
    const beforeMerchant=merchants.data.find(target=>target.id===row.merchant_id)?.name??(row.merchant_id?row.merchant_id:'unassigned');
    const beforeCategory=categories.data.find(target=>target.id===row.category_id)?.name??(row.category_id?row.category_id:'uncategorized');
    const afterMerchant=review.merchant_name??(Object.hasOwn(review.patch,'merchant_id')?(merchants.data.find(target=>target.id===review.patch.merchant_id)?.name??(review.patch.merchant_id||'unassigned')):beforeMerchant);
    const afterCategory=Object.hasOwn(review.patch,'category_id')?(categories.data.find(target=>target.id===review.patch.category_id)?.name??(review.patch.category_id||'uncategorized')):beforeCategory;
    return <li key={row.id}>{row.posted_on} · <Link className="underline" href={'/money/transactions?transaction='+row.id}>{row.description}</Link> · {formatMoney(row.amount_minor,row.currency_code,workspace.locale)} · before version {row.version}<p>{`Merchant: ${beforeMerchant} → ${afterMerchant}`}</p><p>{`Category: ${beforeCategory} → ${afterCategory}`}</p></li>;
   })}</ul>
   <p className="mt-3 text-sm">Selected totals: {Object.entries(totals).map(([currency,minor])=>formatMoney(minor,currency,workspace.locale)).join('; ')}. Amounts, currency, source evidence and financial links remain unchanged.</p>
   {review.status==='pending'&&<><ApprovalForm reviewId={review.id} canSaveRule={Boolean(review.rule_key)} /><form action={dismissReview} className="mt-3"><input type="hidden" name="reviewId" value={review.id} /><button className="text-sm underline">Dismiss this review</button></form></>}
   {review.batch_id&&!batch.data?.undone&&currentRows.data.length===snapshots.length&&<UndoReviewForm reviewId={review.id} rows={versionedRows.parse(currentRows.data)} />}
  </section>}
  <section aria-label="Organization suggestions" className="space-y-3"><h2 className="text-xl font-semibold">Suggestions needing your review</h2><p className="text-sm text-muted-foreground">Up to 50 entries per page, ordered by posting date and ID. Suggestions compare up to 2,000 recent posted entries and 200 rules; older history is outside this coverage. Retained corrections and explicit source organization take precedence.</p>
   {[...groups.values()].sort((a,b)=>Number(b.proposal.financialReviewRequired)-Number(a.proposal.financialReviewRequired)).map(group=><OrganizationGroup key={group.rows.map(row=>row.id+':'+row.version).join(',')} {...group} merchants={merchants.data} categories={categories.data} requestId={crypto.randomUUID()} locale={workspace.locale} />)}
   {!groups.size&&<p className="text-sm">No uncorrected suggestions on this page. Continue to older entries or use the manual ledger.</p>}
   {next&&<Link className="inline-block text-sm underline" href={'/money/organization?'+next}>Older entries needing organization</Link>}
  </section>
  <section aria-label="Approved organization rules" className="rounded-xl border border-border bg-card p-5"><h2 className="text-xl font-semibold">Your approved rules</h2><ul className="mt-3 space-y-2 text-sm">{rules.data.map(rule=><li key={rule.id} className="flex flex-wrap justify-between gap-2"><span>{rule.description_key} · {rule.enabled?'Enabled':'Disabled'} · version {rule.version}</span><form action={toggleRule}><input type="hidden" name="key" value={rule.description_key} /><input type="hidden" name="merchant" value={rule.merchant_id??''} /><input type="hidden" name="category" value={rule.category_id??''} /><input type="hidden" name="version" value={rule.version} /><input type="hidden" name="enabled" value={String(!rule.enabled)} /><button className="underline">{rule.enabled?'Disable':'Enable'} rule</button></form></li>)}</ul>{!rules.data.length&&<p className="mt-2 text-sm">Approve a preview and opt in to save its rule.</p>}</section>
  <section aria-label="Organization review history"><h2 className="font-semibold">Latest 10 saved reviews</h2><ul className="mt-2 space-y-1 text-sm">{reviews.data.map(row=><li key={row.id}><Link className="underline" href={'/money/organization?review='+row.id}>{row.status} · {new Date(row.created_at).toLocaleString(workspace.locale,{timeZone:workspace.timezone})}</Link></li>)}</ul></section>
 </main>;
}
