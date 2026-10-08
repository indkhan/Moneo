import {beforeEach,expect,it,vi} from 'vitest';
import {requireWorkspace} from '@/lib/auth';
import {loadOrganizationSuggestions} from '@/lib/import-organization-loader';
import {createReview,applyReview,dismissReview,toggleRule,undoReview} from './actions';
const rpc=vi.fn();
vi.mock('@/lib/auth',()=>({requireWorkspace:vi.fn()}));
vi.mock('@/lib/import-organization-loader',()=>({loadOrganizationSuggestions:vi.fn()}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));
vi.mock('next/navigation',()=>({redirect:(url:string)=>{throw new Error('REDIRECT '+url);}}));
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const selection=[{id:id(1),version:3},{id:id(2),version:4}];
function form(values:Record<string,string>){const result=new FormData();for(const [key,value]of Object.entries(values))result.set(key,value);return result;}
beforeEach(()=>{vi.resetAllMocks();vi.mocked(requireWorkspace).mockResolvedValue({supabase:{rpc},workspace:{id:id(10)}} as never);
 rpc.mockResolvedValue({data:{id:id(30)},error:null});
 vi.mocked(loadOrganizationSuggestions).mockResolvedValue({rows:[],proposals:selection.map(row=>({transactionId:row.id,version:row.version,descriptionKey:'northstar market',merchantId:null,categoryId:null,merchantName:'Northstar Market',basis:'review-required',financialReviewRequired:false,evidence:[{id:id(11),version:1}]})),historyLimit:2000,historyCount:3} as never);});
it('creates exact durable review from current server proposals rather than client evidence or money',async()=>{
 const data=form({rows:JSON.stringify(selection),merchant:'new',merchantName:'Northstar Market',category:id(20),requestId:id(40)});
 await expect(createReview({},data)).rejects.toThrow('REDIRECT /money/organization?review='+id(30));
 expect(rpc).toHaveBeenCalledWith('create_organization_review',{p_rows:selection,p_patch:{category_id:id(20)},p_merchant_name:'Northstar Market',p_rule_key:'northstar market',p_evidence:[{id:id(11),version:1}],p_request_id:id(40)});
});
it('accepts a 100-character Unicode merchant proposal and rejects 101 characters before writing',async()=>{
 const merchantName='x'.repeat(99)+'\u{10428}';
 const data=form({rows:JSON.stringify(selection),merchant:'new',merchantName,category:'keep',requestId:id(40)});
 await expect(createReview({},data)).rejects.toThrow('REDIRECT');
 expect(rpc).toHaveBeenCalledWith('create_organization_review',expect.objectContaining({p_merchant_name:merchantName}));
 rpc.mockClear();data.set('merchantName',merchantName+'x');
 expect(await createReview({},data)).toHaveProperty('error');expect(rpc).not.toHaveBeenCalled();
});
it('keeps a usable error state and refuses corrected, stale or malformed selections before writing',async()=>{
 const data=form({rows:JSON.stringify(selection),merchant:'new',merchantName:'Northstar Market',category:'keep',requestId:id(40)});
 vi.mocked(loadOrganizationSuggestions).mockResolvedValueOnce({proposals:[]} as never);
 expect(await createReview({},data)).toHaveProperty('error');expect(rpc).not.toHaveBeenCalled();
 data.set('rows',JSON.stringify([selection[0],selection[0]]));expect(await createReview({},data)).toHaveProperty('error');
 data.set('rows',JSON.stringify(selection));vi.mocked(requireWorkspace).mockRejectedValueOnce(new Error('Unauthorized'));
 expect(await createReview({},data)).toHaveProperty('error');expect(rpc).not.toHaveBeenCalled();
});
it('requires explicit approval and sends only review identity and rule intent to the guarded RPC',async()=>{
 const data=form({reviewId:id(30),saveRule:'true'});expect(await applyReview({},data)).toHaveProperty('error');expect(rpc).not.toHaveBeenCalled();
 data.set('confirmed','true');await expect(applyReview({},data)).rejects.toThrow('REDIRECT');
 expect(rpc).toHaveBeenCalledWith('apply_organization_review',{p_review_id:id(30),p_save_rule:true});
});
it('keeps approval failures recoverable and uses owned version guards for rule toggles',async()=>{
 rpc.mockResolvedValueOnce({error:{message:'Transaction changed'}});expect(await applyReview({},form({reviewId:id(30),confirmed:'true'}))).toHaveProperty('error');
 await expect(toggleRule(form({key:'northstar market',merchant:id(21),category:id(20),version:'2',enabled:'false'}))).rejects.toThrow('REDIRECT');
 expect(rpc).toHaveBeenLastCalledWith('save_organization_rule',{p_workspace:id(10),p_key:'northstar market',p_merchant:id(21),p_category:id(20),p_enabled:false,p_expected_version:2});
 await expect(dismissReview(form({reviewId:id(30)}))).rejects.toThrow('REDIRECT');expect(rpc).toHaveBeenLastCalledWith('dismiss_organization_review',{p_review_id:id(30)});
});
it('returns organization Undo to its owned review and guards the full current selection',async()=>{
 const lookup={select:()=>lookup,eq:()=>lookup,maybeSingle:async()=>({data:{batch_id:id(50)},error:null})};
 vi.mocked(requireWorkspace).mockResolvedValueOnce({supabase:{rpc,from:()=>lookup},workspace:{id:id(10)}} as never);
 await expect(undoReview({},form({reviewId:id(30),rows:JSON.stringify(selection)}))).rejects.toThrow('REDIRECT /money/organization?review='+id(30));
 expect(rpc).toHaveBeenCalledWith('undo_transaction_batch',{p_batch_id:id(50),p_rows:selection});
});
