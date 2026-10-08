import {expect, it} from "vitest";
import {detectRecurring} from "./recurring";
it("evaluates the 10,000-row single-merchant ceiling with bounded real evidence", () => {
  const rows = Array.from({length: 10000}, (_,index) => ({id: `large-${index}`,date: new Date(Date.UTC(1999,0,1+index)).toISOString().slice(0,10),description: "Synthetic dense merchant",merchantId: "synthetic-merchant",amountMinor: -9007199254740993n,currencyCode: "EUR",accountId: "synthetic-account"}));
  const started = performance.now(), candidates = detectRecurring(rows);
  expect(candidates.length).toBeGreaterThan(0);
  expect(candidates.every(candidate => candidate.transactionIds.length<=1000 && candidate.transactionIds.includes(candidate.runAnchorId))).toBe(true);
  const selected = candidates.flatMap(candidate => candidate.transactionIds);
  expect(new Set(selected).size).toBe(selected.length);
  expect(candidates.every(candidate => candidate.amountMinMinor===-9007199254740993n && candidate.amountMaxMinor===-9007199254740993n)).toBe(true);
  console.info("MNE014 maximum single-merchant history",JSON.stringify({rows: rows.length,candidates: candidates.length,evidenceRows: selected.length,milliseconds: Math.round(performance.now()-started)}));
});
