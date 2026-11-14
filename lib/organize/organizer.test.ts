import { expect, it, vi } from "vitest";
import type { RawContext } from "@/lib/bank/raw-context";
import { organize, type AskRequest, type OrganizeInput, type OrganizeRow } from "./organizer";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [groceries, dining] = [id(60), id(61)];
const raw = (extra: Partial<RawContext>): RawContext => ({ payment_type: "card", bank_code: null, bank_sub_code: null, mcc: null, counterparty_name: null, counterparty_iban: null, counterparty_bic: null,
  counterparty_ids: [], own_side_ids: [], creditor_id: null, mandate_ref: null, instructed_amount: null, instructed_currency: null, exchange_rate: null, own_account: false, bank_id: "synthetic", ...extra });
const row = (n: number, description: string, identityId: string | null, extra: Partial<RawContext> = {}): OrganizeRow => ({ id: id(n), version: 1, description, amountMinor: -1250n, currency: "EUR",
  date: "2026-10-01", accountId: id(900), identityId, categoryId: null, merchantId: null, raw: raw(extra) });
const identity = (n: number, displayName: string) => [id(n), { id: id(n), kind: "merchant" as const, displayName, merchantId: null }] as const;

function input(): OrganizeInput {
  return {
    rows: [row(1, "CARD 4711 DE89370400440532013000", id(101), { counterparty_name: "Northstar Market", counterparty_iban: "DE89370400440532013000" }), row(2, "CARD 4712", id(101)),
      row(3, "CARD 5000", id(102)), row(4, "CARD 6000", id(103)), row(5, "CARD 7000", id(104)),
      row(6, "METROLINIE TICKET", null), row(7, "CARD 8000", id(105)), row(8, "CARD 9000", id(106), { mcc: "5411", counterparty_name: "Freshkorb GmbH" })],
    history: [], identities: new Map([identity(101, "Northstar Market"), identity(102, "Bistro Vela"), identity(103, "Mystery Shop"), identity(104, "Glanzwerk"), identity(105, "Cafe Luna"), identity(106, "Freshkorb")]),
    rules: [{ id: id(70), version: 1, descriptionKey: "metrolinie ticket", merchantId: null, categoryId: dining, approvedBy: id(1), enabled: true }],
    memory: new Map([[id(105), { identityId: id(105), categoryId: dining, merchantId: null, purpose: null }]]),
    categories: new Map([[groceries, "Groceries"], [dining, "Dining"]]), merchants: new Map(), accounts: new Map([[id(900), "Giro DE89370400440532013000"]]), suppressed: new Map(),
  };
}

// The old categorizer told the model to omit anything uncertain, and 46% of rows stayed blank with nothing to show for it.
it("ends every row with a label or a question: skipped answers are asked again once, then become questions", async () => {
  const prompts: string[] = [];
  const ask = vi.fn(async ({ prompt }: AskRequest) => {
    prompts.push(prompt);
    const { items } = JSON.parse(prompt.slice(prompt.indexOf("{"))) as { items: { ref: string; who: { name: string } }[] };
    const retry = prompt.startsWith("Your last answer");
    return { answers: items.flatMap(item => {
      const answer = { ref: item.ref, decision: "label", category: "c1", newCategory: null, merchant: item.who.name, confidence: 90, reason: "Supermarket", question: null };
      if (item.who.name === "Northstar Market") return [answer];
      if (item.who.name === "Bistro Vela") return retry ? [{ ...answer, category: "c2", confidence: 70 }] : [];
      if (item.who.name === "Glanzwerk") return [{ ...answer, category: "c99" }]; // not a category it was given
      return [];
    }) };
  });
  const result = await organize(input(), ask, { backoffMs: 0 });

  expect(ask).toHaveBeenCalledTimes(2);
  const decided = new Map(result.decided.flatMap(item => item.rows.map(row => [row.id, item.decision] as const)));
  expect(result.decided.flatMap(item => item.rows).length).toBe(8);
  expect(decided.size).toBe(8);
  expect(result.left).toEqual([]);
  // The owner's rule, memory and the bank's code decide without the AI.
  expect(decided.get(id(6))).toMatchObject({ kind: "label", source: "rule", categoryId: dining });
  expect(decided.get(id(7))).toMatchObject({ kind: "label", source: "memory", categoryId: dining });
  expect(decided.get(id(8))).toMatchObject({ kind: "label", source: "system", categoryId: groceries, merchantName: "Freshkorb" });
  // One decision per identity: both Northstar rows share one answer.
  expect(decided.get(id(1))).toMatchObject({ kind: "label", source: "ai", categoryId: groceries, merchantName: "Northstar Market", confidence: 90 });
  expect(decided.get(id(2))).toBe(decided.get(id(1)));
  expect(decided.get(id(3))).toMatchObject({ kind: "label", categoryId: dining, confidence: 70 });
  expect(decided.get(id(4))).toMatchObject({ kind: "question" });
  expect(decided.get(id(5))).toMatchObject({ kind: "question" });
  expect(JSON.parse(prompts[0].slice(prompts[0].indexOf("{"))).items).toHaveLength(4);
  // Only the skipped and unusable answers are asked again.
  expect(JSON.parse(prompts[1].slice(prompts[1].indexOf("{"))).items.map((item: { who: { name: string } }) => item.who.name).sort()).toEqual(["Bistro Vela", "Glanzwerk", "Mystery Shop"]);
  // No IBAN or full account number leaves the computer.
  expect(prompts.join("\n")).not.toMatch(/DE89370400440532013000|0532013000/);
});

it("without a model, rows nobody else could decide wait for the next run instead of becoming questions", async () => {
  const result = await organize(input(), null);
  expect(result.decided.flatMap(item => item.rows.map(row => row.id)).sort()).toEqual([id(6), id(7), id(8)]);
  expect(result.left.map(row => row.id).sort()).toEqual([id(1), id(2), id(3), id(4), id(5)]);
});
