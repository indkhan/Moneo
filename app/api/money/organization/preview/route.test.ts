import {beforeEach,expect,it,vi} from 'vitest';
import {requireWorkspace} from '@/lib/auth';
import {loadOrganizationPreview} from '@/lib/import-organization-preview';
import {POST} from './route';
vi.mock('@/lib/auth',()=>({requireWorkspace:vi.fn()}));
vi.mock('@/lib/import-organization-preview',async original=>({...await original<typeof import('@/lib/import-organization-preview')>(),loadOrganizationPreview:vi.fn()}));
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const selection={rows:[{id:id(1),version:3}],categoryId:id(2),merchantId:id(3)};
const db={} as never;
function request(value:unknown) {return new Request('http://localhost/api/money/organization/preview',{method:'POST',body:JSON.stringify(value)});}
beforeEach(()=>{vi.resetAllMocks();vi.mocked(requireWorkspace).mockResolvedValue({supabase:db,workspace:{id:id(10)}} as never);});
it('returns the exact owned history preview without calling a provider or applying changes',async()=>{
  const preview={rows:[{id:id(1),version:3,amount_minor:'-9007199254740993',currency_code:'EUR'}],totals:{EUR:'-9007199254740993'},patch:{category_id:id(2),merchant_id:id(3)},targets:{category:{id:id(2),name:'Food'},merchant:{id:id(3),name:'Northstar'}}};
  vi.mocked(loadOrganizationPreview).mockResolvedValue(preview as never);
  const response=await POST(request(selection));
  expect(response.status).toBe(200);expect(await response.json()).toEqual(preview);
  expect(loadOrganizationPreview).toHaveBeenCalledWith(db,id(10),selection);
});
it('rejects unauthenticated, malformed, oversized or financially mutable requests before database reads',async()=>{
  vi.mocked(requireWorkspace).mockRejectedValueOnce(new Error('Not authenticated'));
  expect((await POST(request(selection))).status).toBe(401);
  for(const value of [{...selection,amountMinor:'9'},{...selection,rows:[selection.rows[0],selection.rows[0]]},{...selection,merchantId:'foreign-looking'},'x'.repeat(10001)])
    expect((await POST(request(value))).status).toBe(400);
  expect((await POST(new Request('http://localhost',{method:'POST',body:'{'}))).status).toBe(400);
  expect(loadOrganizationPreview).not.toHaveBeenCalled();
});
it('returns a reloadable conflict when the exact owned preview is no longer available',async()=>{
  vi.mocked(loadOrganizationPreview).mockRejectedValue(new Error('The exact selection changed; reload the organization preview'));
  const response=await POST(request(selection));
  expect(response.status).toBe(409);expect(await response.json()).toEqual({error:'The selected history or organization targets changed; reload the preview'});
});
