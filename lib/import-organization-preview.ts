import type {SupabaseClient} from '@supabase/supabase-js';
import {z} from 'zod';
import {versionedRows} from '@/app/money/transactions/input';

export const organizationPreviewSchema=z.object({rows:versionedRows,categoryId:z.uuid().nullable().optional(),merchantId:z.uuid().nullable().optional()}).strict()
  .refine(value=>'categoryId' in value || 'merchantId' in value,'Choose a category or merchant change');
export async function loadOrganizationPreview(db:SupabaseClient,workspaceId:string,value:unknown) {
  z.uuid().parse(workspaceId);
  const input=organizationPreviewSchema.parse(value);
  const [entries,category,merchant]=await Promise.all([
    db.from('transactions').select('id,version,description,posted_on,amount_minor::text,currency_code,merchant_id,category_id,status,kind,review_reasons,tags,event_name')
      .eq('workspace_id',workspaceId).neq('status','voided').in('id',input.rows.map(row=>row.id)),
    input.categoryId?db.from('categories').select('id,name').eq('workspace_id',workspaceId).eq('id',input.categoryId).maybeSingle():{data:null,error:null},
    input.merchantId?db.from('merchants').select('id,name').eq('workspace_id',workspaceId).eq('id',input.merchantId).maybeSingle():{data:null,error:null},
  ]);
  if(entries.error || category.error || merchant.error)throw entries.error??category.error??merchant.error;
  if((input.categoryId && !category.data) || (input.merchantId && !merchant.data))throw new Error('The owned organization target is unavailable');
  const current=new Map(entries.data.map(row=>[row.id,row]));
  if(current.size!==input.rows.length || entries.data.length!==current.size || input.rows.some(row=>current.get(row.id)?.version!==row.version))
    throw new Error('The exact selection changed; reload the organization preview');
  const totals:Record<string,string>={};
  for(const row of entries.data) {
    z.string().regex(/^-?\d+$/).parse(row.amount_minor); z.string().regex(/^[A-Z]{3}$/).parse(row.currency_code);
    totals[row.currency_code]=(BigInt(totals[row.currency_code]??'0')+BigInt(row.amount_minor)).toString();
  }
  const patch:Record<string,string|null>={};
  if('categoryId' in input)patch.category_id=input.categoryId??null;
  if('merchantId' in input)patch.merchant_id=input.merchantId??null;
  return {rows:input.rows.map(row=>current.get(row.id)!),totals,patch,targets:{category:category.data,merchant:merchant.data}};
}
