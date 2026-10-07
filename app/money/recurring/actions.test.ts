import {expect, it, vi, beforeEach} from "vitest";
import {confirmSeries, declineSeries} from "./actions";
const {rpc} = vi.hoisted(() => ({rpc: vi.fn<(name: string, args: Record<string, unknown>) => Promise<{error: null}>>().mockResolvedValue({error: null})}));
vi.mock("@/lib/auth", () => ({requireWorkspace: async () => ({supabase: {rpc}})}));
vi.mock("next/cache", () => ({revalidatePath: vi.fn()}));
vi.mock("next/navigation", () => ({redirect: () => {throw new Error("REDIRECT");}}));
const account = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const sourceIds = [1,2,3].map(n => `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${String(n).repeat(12)}`);
const evidence = sourceIds.map((id,version) => ({id,version}));
function form(cadence: string) {
  const data = new FormData();
  for (const [key,value] of Object.entries({accountId: account,label: "Utility",cadence,currencyCode: "EUR",amountMinMinor: "-9007199254740993",amountMaxMinor: "-9007199254740993",occurrences: "3",confidence: "70",transactionIds: sourceIds.join(","),sourceEvidence: JSON.stringify(evidence),runAnchorId: sourceIds[0],evidenceLimited: "false"})) data.set(key,value);
  return data;
}
beforeEach(() => rpc.mockClear());
it.each(["weekly","biweekly","monthly","quarterly","yearly"])("confirms %s through owned versioned receipts without probability input", async cadence => {
  await expect(confirmSeries(form(cadence))).rejects.toThrow("REDIRECT");
  expect(rpc).toHaveBeenCalledWith("review_recurring_series_versions", {p_decision: "confirmed",p_account_id: account,p_label: "Utility",p_cadence: cadence,p_currency_code: "EUR",p_evidence: evidence,p_run_anchor_id: sourceIds[0],p_evidence_limited: false});
});
it("declines with the same receipts and validation path", async () => {
  await expect(declineSeries(form("monthly"))).rejects.toThrow("REDIRECT");
  expect(rpc.mock.calls[0][0]).toBe("review_recurring_series_versions");
  expect(rpc.mock.calls[0][1]).toMatchObject({p_decision: "dismissed",p_evidence: evidence});
});
it.each(["duplicate","missing anchor","invalid date","number money","negative version"])("rejects %s evidence before RPC", async fault => {
  const data = form("monthly"), rows = structuredClone(evidence);
  if (fault === "duplicate") rows[1].id=rows[0].id;
  if (fault === "missing anchor") data.set("runAnchorId",account);
  if (fault === "invalid date") Object.assign(rows[0],{posted_on:"2026-02-30"});
  if (fault === "number money") Object.assign(rows[0],{amount_minor: 9007199254740992});
  if (fault === "negative version") rows[0].version=-1;
  data.set("sourceEvidence",JSON.stringify(rows));
  await expect(confirmSeries(data)).rejects.not.toThrow("REDIRECT");
  expect(rpc).not.toHaveBeenCalled();
});

it("accepts compact expected versions without sending source descriptions or money", async () => {
  const data=form("quarterly"), compact=evidence.map(({id,version})=>({id,version}));
  data.set("sourceEvidence",JSON.stringify(compact));
  await expect(confirmSeries(data)).rejects.toThrow("REDIRECT");
  expect(rpc).toHaveBeenCalledWith("review_recurring_series_versions",expect.objectContaining({p_evidence:compact,p_run_anchor_id:sourceIds[0]}));
});

it("rejects oversized UTF-8 or excess source payloads before RPC", async () => {
  const data=form("monthly");
  data.set("sourceEvidence","\u{1F4B0}".repeat(33000));
  await expect(confirmSeries(data)).rejects.not.toThrow("REDIRECT");
  data.set("sourceEvidence",JSON.stringify(Array.from({length:1001},()=>evidence[0])));
  await expect(confirmSeries(data)).rejects.not.toThrow("REDIRECT");
  expect(rpc).not.toHaveBeenCalled();
});
