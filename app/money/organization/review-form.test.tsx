import {Children,isValidElement,type ReactNode} from 'react';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {OrganizationQueue} from './review-form';
vi.mock('./actions',()=>({createReview:vi.fn(),applyReview:vi.fn(),undoReview:vi.fn()}));
const state=vi.hoisted(()=>[] as unknown[]);
const preselected=vi.hoisted(()=>({ids:[] as string[]}));
vi.mock('react',async importOriginal=>({...await importOriginal<typeof import('react')>(),
 useActionState:()=>[{},vi.fn(),false],useRef:(value:unknown)=>({current:value}),useEffect:()=>{},
 useState:(value:unknown)=>{const index=state.length,initial=index===0?preselected.ids:value;state.push(initial);return [initial,(next:unknown)=>{state[index]=next;}];},
}));
const id='00000000-0000-4000-8000-000000000001';
function element(node:ReactNode,type:string,name?:string,prop='name'):Record<string,unknown>|undefined{
 if(!isValidElement<{children?:ReactNode;[key:string]:unknown}>(node))return;
 if(node.type===type&&(!name||node.props[prop]===name))return node.props;
 for(const child of Children.toArray(node.props.children)){const found=element(child,type,name,prop);if(found)return found;}
}
beforeEach(()=>{state.length=0;preselected.ids=[];});afterEach(()=>vi.unstubAllGlobals());
function chip(node:ReactNode,label:string):(()=>void)|undefined{
 if(!isValidElement<{children?:ReactNode;onClick?:()=>void}>(node))return;
 if(node.type==='button'&&Children.toArray(node.props.children).join('').includes(label))return node.props.onClick;
 for(const child of Children.toArray(node.props.children)){const found=chip(child,label);if(found)return found;}
}
const taxiId='00000000-0000-4000-8000-000000000002';
const queueItem=(rowId:string,description:string,merchantName:string)=>({row:{id:rowId,version:0,description,posted_on:'2026-09-01',amount_minor:'-100',currency_code:'EUR'},
 proposal:{transactionId:rowId,version:0,descriptionKey:description.toLowerCase(),merchantName,merchantId:null,categoryId:null,basis:'review-required' as const,financialReviewRequired:false,evidence:[]}});
const queue=()=>OrganizationQueue({items:[queueItem(id,'Grocer','Grocer'),queueItem(taxiId,'Taxi','Taxi')],merchants:[],categories:[],requestId:id,locale:'en-US'});
it('keeps hand-picked rows without retargeting them to a chip they do not match',()=>{
 preselected.ids=[id];
 chip(queue(),'like this: Taxi')!();
 expect(state[0]).toEqual([id,taxiId]);
 expect(state[1]).toBe('');expect(state[2]).toBe('');
 expect(state[3]).toMatch(/choose the category and merchant yourself/);
});
it('fills the target when every selected row shares the chip',()=>{
 preselected.ids=[taxiId];
 chip(queue(),'like this: Taxi')!();
 expect(state[0]).toEqual([taxiId]);
 expect(state[1]).toBe('Taxi');expect(state[3]).toBe('');
});
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
