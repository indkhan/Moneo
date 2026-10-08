import type {SupabaseClient} from '@supabase/supabase-js';
import {z} from 'zod';
import {versionedRows} from '@/app/money/transactions/input';
import {organizationProposals,organizationRuleSchema,type OrganizationRow} from './import-organization';

const columns='id,version,description,merchant_id,category_id,kind,review_reasons,posted_on,amount_minor::text,currency_code,status';
export async function loadOrganizationSuggestions(db:SupabaseClient,workspaceId:string,selection:unknown) {
 z.uuid().parse(workspaceId);const selected=versionedRows.parse(selection),ids=selected.map(row=>row.id);
 const [current,history,corrections,rules]=await Promise.all([
  db.from('transactions').select(columns).eq('workspace_id',workspaceId).neq('status','voided').in('id',ids),
  db.from('transactions').select(columns).eq('workspace_id',workspaceId).eq('status','posted').order('posted_on',{ascending:false}).order('id',{ascending:false}).limit(2000),
  db.from('correction_events').select('transaction_id').eq('workspace_id',workspaceId).eq('undone',false).in('transaction_id',ids),
  db.from('organization_rules').select('id,version,description_key,merchant_id,category_id,approved_by,enabled').eq('workspace_id',workspaceId).order('description_key').limit(201),
 ]);
 if(current.error||history.error||corrections.error||rules.error)throw current.error??history.error??corrections.error??rules.error;
 const byId=new Map(current.data.map(row=>[row.id,row]));
 if(byId.size!==selected.length||current.data.length!==byId.size||selected.some(row=>byId.get(row.id)?.version!==row.version))throw new Error('The selected history changed; reload suggestions');
 const corrected=new Set(corrections.data.map(event=>event.transaction_id));
 const toRow=(row:typeof current.data[number]):OrganizationRow=>({id:row.id,version:row.version,description:row.description,
  merchantId:row.merchant_id,categoryId:row.category_id,kind:row.kind,reviewReasons:row.review_reasons,userCorrected:corrected.has(row.id)});
 const approved=rules.data.map(rule=>organizationRuleSchema.parse({id:rule.id,version:rule.version,descriptionKey:rule.description_key,
  merchantId:rule.merchant_id,categoryId:rule.category_id,approvedBy:rule.approved_by,enabled:rule.enabled}));
 return {rows:selected.map(row=>byId.get(row.id)!),proposals:organizationProposals(current.data.map(toRow),history.data.map(toRow),approved),historyLimit:2000,historyCount:history.data.length};
}
