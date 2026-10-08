import {beforeEach,expect,it,vi} from 'vitest';
import {requireWorkspace} from '@/lib/auth';
import {redirect} from 'next/navigation';
import {undoCorrection} from './actions';
vi.mock('@/lib/auth',()=>({requireWorkspace:vi.fn()}));
vi.mock('next/navigation',()=>({redirect:vi.fn(()=>{throw new Error('redirect');})}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const rpc=vi.fn();
function client(organization:boolean){
 return {rpc,from:(table:string)=>{const query={select:()=>query,eq:()=>query,maybeSingle:async()=>({data:table==='correction_events'?{after:{operation:'metadata',batch_id:id(3)}}:organization?{id:id(4)}:null,error:null})};return query;}};
}
function form(){const value=new FormData();value.set('eventId',id(1));value.set('transactionId',id(2));value.set('version','1');return value;}
beforeEach(()=>{vi.clearAllMocks();rpc.mockResolvedValue({error:null});});
it('routes existing individual Undo to the full owned organization review without partial writes',async()=>{
 vi.mocked(requireWorkspace).mockResolvedValue({supabase:client(true),workspace:{id:id(10)}} as never);
 await expect(undoCorrection(form())).rejects.toThrow('redirect');
 expect(rpc).not.toHaveBeenCalled();expect(redirect).toHaveBeenCalledWith('/money/organization?review='+id(4));
});
it('preserves existing individual Undo for ordinary metadata batches',async()=>{
 vi.mocked(requireWorkspace).mockResolvedValue({supabase:client(false),workspace:{id:id(10)}} as never);
 await expect(undoCorrection(form())).rejects.toThrow('redirect');
 expect(rpc).toHaveBeenCalledWith('undo_transaction_metadata',{p_event_id:id(1),p_expected_version:1});
});
