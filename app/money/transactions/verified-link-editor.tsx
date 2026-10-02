"use client";
import { useState } from "react";
import { verifiedLink } from "./actions";
import { parseManualAmount } from "./input";
import { formatMoney as formatCurrency } from "@/lib/finance/format";
import { comparisonMinor, transferPrincipal, type LinkRate } from "@/lib/finance/verified-links";
export type LinkPosting = { id: string; version: number; posted_on: string; description: string; amount_minor: string; currency_code: string };
export function VerifiedLinkEditor({ primary, candidates, rates, categories, operation, query, locale }: { primary:LinkPosting; candidates:LinkPosting[]; rates:(LinkRate & {id:string;rate_date:string;source:string})[]; categories:{id:string;name:string}[]; operation:"transfer"|"refund"; query:string;locale?:string }) {
  const formatMoney=(amount:Parameters<typeof formatCurrency>[0],currency:string)=>formatCurrency(amount,currency,locale);
  const [requestId]=useState(()=>crypto.randomUUID()); const [otherId,setOtherId]=useState(""); const [rateId,setRateId]=useState(""); const [amounts,setAmounts]=useState(["0","0"]);
  const [treatments,setTreatments]=useState<("included"|"additional")[]>(["included","included"]); const [notes,setNotes]=useState(["",""]); const [categoryIds,setCategoryIds]=useState(["",""]);
  const [reviewed,setReviewed]=useState(false);
  const other=candidates.find(row=>row.id===otherId); const rate=rates.find(rate=>rate.id===rateId)??null;
  let preview="Choose a source posting to review its impact."; let valid=false; let fees: {transaction_id:string;fee_minor:string;treatment:string;category_id:string|null;note:string}[]=[];
  try {
    if(other) {
      const postings=[primary,other]; const values=postings.map((row,index)=>parseManualAmount(amounts[index],row.currency_code));
      if(values.some(value=>value<0n)) throw new Error("Fee amounts must be nonnegative");
      fees=values.flatMap((amount,index)=>amount===0n?[]:[{transaction_id:postings[index].id,fee_minor:amount.toString(),treatment:treatments[index],category_id:categoryIds[index]||null,note:notes[index].trim()}]);
      if(fees.some(fee=>!fee.note)) throw new Error("Document the source evidence for each fee");
      if(primary.currency_code!==other.currency_code && (!rate || rate.rate_date>(operation==="refund"?primary.posted_on:[primary.posted_on,other.posted_on].sort()[1]))) throw new Error("Choose matching dated FX evidence");
      if(operation==="transfer") {
        const a=transferPrincipal(BigInt(primary.amount_minor),values[0],treatments[0]); const b=transferPrincipal(BigInt(other.amount_minor),values[1],treatments[1]);
        const compared=comparisonMinor(a,primary.currency_code,other.currency_code,rate);
        if(compared!==b) throw new Error(`Principals differ: comparison ${formatMoney(compared,other.currency_code)} versus ${formatMoney(b,other.currency_code)}`);
        preview=`Exclude both transfer principals from income and spending. Retain ${fees.map(fee=>formatMoney(fee.fee_minor,postings.find(row=>row.id===fee.transaction_id)!.currency_code)).join(" + ")||"no documented fees"} as expenses. Included fees leave source balances unchanged; additional fees reduce the posting account balance.`;
      } else {
        const equivalent=comparisonMinor(BigInt(primary.amount_minor),primary.currency_code,other.currency_code,rate);
        preview=`Refund remains ${formatMoney(primary.amount_minor,primary.currency_code)} in its posting currency and period. Compare ${formatMoney(equivalent,other.currency_code)} against this original expense; the database checks the total of all linked refunds.`;
      }
      valid=true;
    }
  } catch(error) { preview=error instanceof Error?error.message:"Review the posting evidence"; }
  const changed=()=>setReviewed(false);
  return <form action={verifiedLink} className="space-y-3 rounded-lg border p-3">
    <h4 className="font-medium">Verified {operation}</h4><p className="text-xs text-muted-foreground">Source amounts and categories remain intact. The latest 100 eligible postings are shown. Undo splits before linking; refund originals require completed classification review.</p>
    <input type="hidden" name="id" value={primary.id}/><input type="hidden" name="version" value={primary.version}/><input type="hidden" name="otherVersion" value={other?.version??""}/><input type="hidden" name="operation" value={operation}/><input type="hidden" name="requestId" value={requestId}/><input type="hidden" name="query" value={query}/><input type="hidden" name="fees" value={JSON.stringify(operation==="transfer"?fees:[])}/>
    <label className="block text-sm">{operation==="transfer"?"Transfer counterpart":"Refund original"}<select name="otherId" required value={otherId} onChange={event=>{setOtherId(event.target.value);changed();}} className="mt-1 w-full rounded border p-2"><option value="">Choose source</option>{candidates.map(row=><option key={row.id} value={row.id}>{row.posted_on} · {row.description} · {formatMoney(row.amount_minor,row.currency_code)}</option>)}</select></label>
    {other&&<a href={`/money/transactions?transaction=${other.id}`} target="_blank" rel="noopener noreferrer" className="block text-sm underline">Inspect other source evidence in a new tab</a>}
    <label className="block text-sm">Dated FX evidence<select name="fxRateId" value={rateId} onChange={event=>{setRateId(event.target.value);changed();}} className="mt-1 w-full rounded border p-2"><option value="">Same currency / choose FX evidence</option>{rates.map(rate=><option key={rate.id} value={rate.id}>{rate.rate_date} · {rate.from_currency}/{rate.to_currency} {rate.rate_text} · {rate.source}</option>)}</select></label>
    {operation==="transfer" && [primary,other].map((row,index)=>row&&<fieldset key={row.id} className="space-y-2 rounded border p-2"><legend className="text-sm">Fee on {row.description} ({row.currency_code})</legend>
      <label className="block text-sm">Fee amount<input value={amounts[index]} onChange={event=>{setAmounts(amounts.map((value,i)=>i===index?event.target.value:value));changed();}} inputMode="decimal" className="ml-2 rounded border p-1"/></label>
      <label className="block text-sm">Fee treatment<select value={treatments[index]} onChange={event=>{setTreatments(treatments.map((value,i)=>i===index?event.target.value as "included"|"additional":value));changed();}} className="ml-2 rounded border p-1"><option value="included">Included in source posting</option><option value="additional">Additional documented debit</option></select></label>
      <label className="block text-sm">Fee category<select value={categoryIds[index]} onChange={event=>{setCategoryIds(categoryIds.map((value,i)=>i===index?event.target.value:value));changed();}} className="ml-2 rounded border p-1"><option value="">Uncategorized</option>{categories.map(category=><option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
      <label className="block text-sm">Fee source evidence<input value={notes[index]} maxLength={500} onChange={event=>{setNotes(notes.map((value,i)=>i===index?event.target.value:value));changed();}} className="mt-1 w-full rounded border p-1"/></label>
    </fieldset>)}
    <p role="status" className="rounded bg-muted p-3 text-sm">{preview}</p><label className="flex gap-2 text-sm"><input type="checkbox" name="confirmed" value="true" checked={reviewed} onChange={event=>setReviewed(event.target.checked)}/>I reviewed the source postings, FX evidence and fee impact</label><button disabled={!valid||!reviewed} className="rounded border px-3 py-2 text-sm disabled:opacity-50">Confirm verified {operation}</button>
  </form>;
}
