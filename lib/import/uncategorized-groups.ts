import {organizationDescriptionKey,organizationDisplayName} from '@/lib/import/organization';

export type UncategorizedGroup={key:string;label:string;count:number;rows:{id:string;version:number}[];suggested:string|null;
 recent:{id:string;date:string;amountMinor:string;currency:string}[]};
export type UncategorizedRow={id:string;version:number;description:string;posted_on:string;amount_minor:string;currency_code:string;merchants:{name:string}|{name:string}[]|null};

export function groupUncategorized(rows:UncategorizedRow[],picked:Map<string,string>):UncategorizedGroup[]{
 const groups=new Map<string,UncategorizedGroup>();
 for(const row of rows){
  const key=organizationDescriptionKey(row.description)||row.description;
  const merchant=[row.merchants].flat()[0]?.name;
  const group:UncategorizedGroup=groups.get(key)??{key,label:merchant??organizationDisplayName(key),count:0,rows:[],suggested:null,recent:[]};
  group.count++;
  group.rows.push({id:row.id,version:row.version});
  if(group.recent.length<8)group.recent.push({id:row.id,date:row.posted_on,amountMinor:row.amount_minor,currency:row.currency_code});
  group.suggested??=picked.get(row.id)??null;
  groups.set(key,group);
 }
 const all=[...groups.values()].sort((a,b)=>b.count-a.count);
 const named=Map.groupBy(all,group=>group.label);
 for(const group of all)if(named.get(group.label)!.length>1)group.label=organizationDisplayName(group.key);
 return all;
}
