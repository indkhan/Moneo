import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {generateObject} from 'ai';
import {requireWorkspace} from '@/lib/auth';
import {loadOrganizationSuggestions} from '@/lib/import-organization-loader';
import {modelForSettings} from '@/lib/ai/provider';
import {settingsSchema} from '@/lib/settings';
import {POST} from './route';
vi.mock('ai',()=>({generateObject:vi.fn()}));
vi.mock('@/lib/auth',()=>({requireWorkspace:vi.fn()}));
vi.mock('@/lib/import-organization-loader',()=>({loadOrganizationSuggestions:vi.fn()}));
vi.mock('@/lib/ai/provider',()=>({modelForSettings:vi.fn()}));
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const row={id:id(1),version:0,description:'NORTHSTAR MARKET REF:771',merchant_id:null,category_id:null,kind:'ordinary',review_reasons:[],amount_minor:'-9007199254740993',currency_code:'EUR'};
const proposal={transactionId:id(1),version:0,descriptionKey:'northstar market',merchantId:null,categoryId:null,merchantName:'northstar market',basis:'review-required',financialReviewRequired:false,evidence:[]};
const selection={rows:[{id:id(1),version:0}],useProvider:true};
const db={from:()=>{const q={select:()=>q,eq:()=>q,order:()=>q,limit:async()=>({data:[{id:id(20),name:'Groceries'}],error:null})};return q;}};
afterEach(()=>vi.unstubAllEnvs());
function request(value:unknown){return new Request('http://localhost/api/money/organization/suggestions',{method:'POST',body:JSON.stringify(value)});}
beforeEach(()=>{vi.resetAllMocks();vi.stubEnv('OPENROUTER_API_KEY','synthetic-test-only');vi.mocked(requireWorkspace).mockResolvedValue({supabase:db,workspace:{id:id(10)},settings:settingsSchema.parse({})} as never);
 vi.mocked(loadOrganizationSuggestions).mockResolvedValue({rows:[row],proposals:[proposal],historyLimit:2000,historyCount:0} as never);
 vi.mocked(modelForSettings).mockResolvedValue({} as never);});
it('returns attributable metadata only and never sends exact amounts to the optional provider',async()=>{
 vi.mocked(generateObject).mockResolvedValue({object:[{transactionId:id(1),merchantName:'Northstar Market',categoryId:id(20),evidenceQuote:'NORTHSTAR MARKET'}]} as never);
 const response=await POST(request(selection));expect(response.status).toBe(200);
 expect(await response.json()).toMatchObject({providerStatus:'available',proposals:[{basis:'provider-suggestion',categoryId:id(20),evidenceQuote:'NORTHSTAR MARKET'}]});
 expect(vi.mocked(generateObject).mock.calls[0][0].prompt).not.toContain('9007199254740993');
 expect(vi.mocked(generateObject).mock.calls[0][0]).toMatchObject({maxRetries:0});
});
it('preserves a usable manual path on failure, unsupported evidence, or disabled AI scope',async()=>{
 for(const output of [new Error('Provider down'),{object:[{transactionId:id(1),merchantName:'Invented',categoryId:id(40),evidenceQuote:'not present'}]}]){
  if(output instanceof Error)vi.mocked(generateObject).mockRejectedValueOnce(output);else vi.mocked(generateObject).mockResolvedValueOnce(output as never);
  const body=await (await POST(request(selection))).json();expect(body).toMatchObject({providerStatus:'unavailable',manualPath:'/money/transactions',proposals:[proposal]});
 }
 vi.mocked(requireWorkspace).mockResolvedValueOnce({supabase:db,workspace:{id:id(10)},settings:settingsSchema.parse({ai_data_scopes:[]})} as never);
 const count=vi.mocked(generateObject).mock.calls.length;expect(await(await POST(request(selection))).json()).toHaveProperty('providerStatus','unavailable');expect(generateObject).toHaveBeenCalledTimes(count);
});
it('requires authenticated bounded current selections and skips provider calls unless requested',async()=>{
 vi.mocked(requireWorkspace).mockRejectedValueOnce(new Error('Unauthorized'));expect((await POST(request(selection))).status).toBe(401);
 for(const value of [{...selection,amountMinor:'9'},{...selection,rows:[selection.rows[0],selection.rows[0]]},'x'.repeat(10001)])expect((await POST(request(value))).status).toBe(400);
 expect(generateObject).not.toHaveBeenCalled();
 expect(await(await POST(request({...selection,useProvider:false}))).json()).toHaveProperty('providerStatus','not-requested');expect(generateObject).not.toHaveBeenCalled();
});
it('does not send ruled or consistently organized rows to a provider that cannot override their authority',async()=>{
 vi.mocked(loadOrganizationSuggestions).mockResolvedValueOnce({rows:[row],proposals:[{...proposal,basis:'approved-rule',merchantId:id(30),categoryId:id(20),rule:{id:id(40),version:2}}],historyLimit:2000,historyCount:3} as never);
 expect(await(await POST(request(selection))).json()).toHaveProperty('providerStatus','not-requested');expect(generateObject).not.toHaveBeenCalled();expect(modelForSettings).not.toHaveBeenCalled();
});
