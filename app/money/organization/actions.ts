'use server';
import {z} from 'zod';
import {redirect} from 'next/navigation';
import {revalidatePath} from 'next/cache';
import {requireWorkspace} from '@/lib/auth';
import {loadOrganizationSuggestions} from '@/lib/import-organization-loader';
import {versionedRows} from '../transactions/input';

export type ReviewState={error?:string};
const target=z.union([z.uuid(),z.literal('keep'),z.literal('')]);
export async function createReview(_state:ReviewState,form:FormData):Promise<ReviewState> {
 let reviewId:string;
 try {
  const {supabase,workspace}=await requireWorkspace();
  const rows=versionedRows.parse(JSON.parse(z.string().max(5000).parse(form.get('rows'))));
  const merchant=z.union([target,z.literal('new')]).parse(form.get('merchant'));
  const category=target.parse(form.get('category'));
  const merchantName=merchant==='new'?z.string().trim().min(1).max(100).parse(form.get('merchantName')):null;
  const requestId=z.uuid().parse(form.get('requestId'));
  const current=await loadOrganizationSuggestions(supabase,workspace.id,rows);
  if(current.proposals.length!==rows.length)throw new Error('Corrections or complete source organization take precedence');
  const patch:Record<string,string|null>={};
  if(merchant!=='keep'&&merchant!=='new')patch.merchant_id=merchant||null;
  if(category!=='keep')patch.category_id=category||null;
  if(!merchantName&&!Object.keys(patch).length)throw new Error('Choose an organization change');
  const keys=new Set(current.proposals.map(proposal=>proposal.descriptionKey));
  const key=keys.size===1?[...keys][0]:null;
  const evidence=[...new Map(current.proposals.flatMap(proposal=>proposal.evidence).map(row=>[row.id,row])).values()];
  const {data,error}=await supabase.rpc('create_organization_review',{p_rows:rows,p_patch:patch,p_merchant_name:merchantName,
   p_rule_key:key&&key.length>=3?key:null,p_evidence:evidence,p_request_id:requestId});
  if(error)throw error;reviewId=z.uuid().parse(data.id);
 } catch {return {error:'Could not create a review. Reload changed rows, or use Transactions for a manual correction.'};}
 revalidatePath('/money/organization');redirect('/money/organization?review='+reviewId);
}
export async function applyReview(_state:ReviewState,form:FormData):Promise<ReviewState> {
 let reviewId:string;
 try {
  const {supabase}=await requireWorkspace();
  z.literal('true').parse(form.get('confirmed'));reviewId=z.uuid().parse(form.get('reviewId'));
  const saveRule=z.enum(['true','false']).parse(form.get('saveRule')??'false')==='true';
  const {error}=await supabase.rpc('apply_organization_review',{p_review_id:reviewId,p_save_rule:saveRule});if(error)throw error;
 } catch {return {error:'Approval could not be applied. History or its rule may have changed; create a fresh review. Manual correction remains available in Transactions.'};}
 revalidatePath('/','layout');redirect('/money/organization?review='+reviewId);
}
export async function dismissReview(form:FormData) {
 const {supabase}=await requireWorkspace();const {error}=await supabase.rpc('dismiss_organization_review',{p_review_id:z.uuid().parse(form.get('reviewId'))});
 if(error)throw new Error(error.message);revalidatePath('/money/organization');redirect('/money/organization');
}
export async function undoReview(_state:ReviewState,form:FormData):Promise<ReviewState> {
 let reviewId:string;
 try{
  const {supabase,workspace}=await requireWorkspace();reviewId=z.uuid().parse(form.get('reviewId'));
  const rows=versionedRows.parse(JSON.parse(z.string().max(5000).parse(form.get('rows'))));
  const {data,error:lookupError}=await supabase.from('organization_reviews').select('batch_id').eq('workspace_id',workspace.id).eq('id',reviewId).maybeSingle();
  if(lookupError||!data?.batch_id)throw new Error('Applied review not found');
  const {error}=await supabase.rpc('undo_transaction_batch',{p_batch_id:z.uuid().parse(data.batch_id),p_rows:rows});if(error)throw error;
 }catch{return {error:'Undo could not be applied. A transaction or saved rule may have a later edit; undo that change first.'};}
 revalidatePath('/','layout');redirect('/money/organization?review='+reviewId);
}
export async function toggleRule(form:FormData) {
 const {supabase,workspace}=await requireWorkspace();
 const {error}=await supabase.rpc('save_organization_rule',{p_workspace:workspace.id,p_key:z.string().trim().min(3).max(1000).parse(form.get('key')),
  p_merchant:form.get('merchant')?z.uuid().parse(form.get('merchant')):null,p_category:form.get('category')?z.uuid().parse(form.get('category')):null,
  p_enabled:z.enum(['true','false']).parse(form.get('enabled'))==='true',p_expected_version:z.coerce.number().int().min(1).max(2147483647).parse(form.get('version'))});
 if(error)throw new Error(error.message);revalidatePath('/money/organization');redirect('/money/organization');
}
