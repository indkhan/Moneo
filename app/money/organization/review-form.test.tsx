import {Children,isValidElement,type ReactNode} from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {OrganizationQueue} from './review-form';
vi.mock('./actions',()=>({createReview:vi.fn(),applyReview:vi.fn(),undoReview:vi.fn()}));
const state=vi.hoisted(()=>[] as unknown[]);
vi.mock('react',async importOriginal=>({...await importOriginal<typeof import('react')>(),
 useActionState:()=>[{},vi.fn(),false],useRef:(value:unknown)=>({current:value}),
 useState:(value:unknown)=>{const index=state.length;state.push(value);return [value,(next:unknown)=>{state[index]=next;}];},
}));
const id='00000000-0000-4000-8000-000000000001';
function element(node:ReactNode,type:string,name?:string,prop='name'):Record<string,unknown>|undefined{
 if(!isValidElement<{children?:ReactNode;[key:string]:unknown}>(node))return;
 if(node.type===type&&(!name||node.props[prop]===name))return node.props;
 for(const child of Children.toArray(node.props.children)){const found=element(child,type,name,prop);if(found)return found;}
}
beforeEach(()=>{state.length=0;});afterEach(()=>vi.unstubAllGlobals());
it('retains a newer manual draft when an older optional suggestion completes',async()=>{
 let complete!:(value:unknown)=>void;
 vi.stubGlobal('fetch',vi.fn(()=>new Promise(resolve=>{complete=resolve;})));
 const proposal={transactionId:id,version:0,descriptionKey:'cedar shop',merchantName:'cedar shop',merchantId:null,categoryId:null,basis:'review-required' as const,financialReviewRequired:false,evidence:[]};
 const tree=OrganizationQueue({items:[{row:{id,version:0,description:'CEDAR SHOP REF:1',posted_on:'2026-09-01',amount_minor:'-100',currency_code:'EUR'},proposal}],
  merchants:[],categories:[],requestId:id,locale:'en-US'});
 const request=element(tree,'button','button','type')!.onClick as ()=>Promise<void>;
 const pending=request();
 (element(tree,'input','merchantSearch')!.onChange as (event:unknown)=>void)({target:{value:'Typed by hand'}});
 complete({ok:true,json:async()=>({providerStatus:'available',proposals:[{transactionId:id,basis:'provider-suggestion',merchantName:'Cedar Shop',merchantId:null,categoryId:null}]})});
 await pending;
 expect(state[1]).toBe('Typed by hand');expect(state[2]).toBe('');
 expect(state[3]).toMatch(/draft changed/i);
});
