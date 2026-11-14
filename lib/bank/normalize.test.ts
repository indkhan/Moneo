import { describe, expect, it } from "vitest";
import type { BankTransaction } from "./enable-banking";
import { boundedRaw, normalizeBankTransaction, paymentType, sepaReferences } from "./normalize";

const tx = (over: Record<string, unknown> = {}) => ({
  entry_reference: "e1", transaction_amount: { currency: "EUR", amount: "10.00" }, credit_debit_indicator: "DBIT", status: "BOOK", booking_date: "2026-10-01", ...over,
}) as BankTransaction;

describe("payment type", () => {
  it.each([
    // ISO 20022: the most specific level wins.
    ["PMNT", "ICDT/STDO", "transfer"], ["PMNT/ICDT/STDO", null, "transfer"], ["PMNT-CCRD-POSD", null, "card"], ["PMNT", "CCRD/CWDL", "cash"],
    ["PMNT/IDDT/PMDD", null, "direct_debit"], ["PMNT/RDDT", null, "direct_debit"], ["PMNT/CNTR/CDPT", null, "cash"], ["PMNT/MCOP/CHRG", null, "fee_interest"], ["FORX", null, "exchange"],
    // Proprietary codes, case-insensitive whole words.
    ["CARD_PAYMENT", null, "card"], ["card_payment", null, "card"], ["TRANSFER", null, "transfer"], ["SEPA_TRF", null, "transfer"], ["DIRECT_DEBIT", null, "direct_debit"],
    ["Lastschrift", null, "direct_debit"], ["ATM", null, "cash"], ["CARD_ATM", null, "cash"], ["TOPUP", null, "top_up"], ["TOP_UP", null, "top_up"],
    ["CARD_FEE", null, "fee_interest"], ["INTEREST", null, "fee_interest"], ["FX", null, "exchange"],
    // Unknown never blocks anything; a word inside another word is not a match.
    ["REV_PAYMENT", null, "unknown"], ["CARDINAL", null, "unknown"], ["XYZ1", "Q", "unknown"], [null, null, "unknown"],
  ])("%s %s -> %s", (code, sub, expected) => expect(paymentType(code, sub)).toBe(expected));

  it("reads the bank's own description when the code says nothing", () => expect(paymentType("123", null, "Card payment")).toBe("card"));
});

describe("SEPA references in the remittance text", () => {
  it.each([
    ["Gläubiger-ID: DE98ZZZ09999999999 Mandatsref: M-2026-0042 Miete", "DE98ZZZ09999999999", "M-2026-0042"],
    ["CRED+DE98ZZZ09999999999 MREF+MANDATE123 EREF+NOTPROVIDED", "DE98ZZZ09999999999", "MANDATE123"],
    ["Creditor ID FR12ZZZ123456 Mandate reference ABC-9", "FR12ZZZ123456", "ABC-9"],
    ["CI DE98ZZZ09999999999 Mandatsreferenz 4711.", "DE98ZZZ09999999999", "4711"],
    ["Stromabschlag DE98ZZZ09999999999", "DE98ZZZ09999999999", null], // the ZZZ business code identifies a creditor id by itself
    ["Mandate expired, thanks", null, null], // a mandate reference carries a digit
    ["Rent October for the flat", null, null],
  ])("%s", (text, creditor, mandate) => expect(sepaReferences(text)).toEqual({ creditor_id: creditor, mandate_ref: mandate }));
});

describe("normalizing a bank transaction", () => {
  const own = new Set(["DE89370400440532013000"]);

  it("takes the counterparty from the creditor side when money leaves", () => {
    const result = normalizeBankTransaction(tx({
      creditor: { name: "Corner Shop" }, debtor: { name: "Me" }, creditor_account: { iban: "NL91 ABNA 0417 1643 00" }, debtor_account: { iban: "DE89370400440532013000" },
      creditor_agent: { bic_fi: "ABNANL2A" }, merchant_category_code: "5411", bank_transaction_code: { code: "CARD_PAYMENT", sub_code: "POS" },
      creditor_account_additional_identification: [{ identification: "shop-1", scheme_name: "OTHER" }], debtor_account_additional_identification: [{ identification: "card-9" }],
    }), own);
    expect(result).toMatchObject({ payment_type: "card", bank_code: "CARD_PAYMENT", bank_sub_code: "POS", mcc: "5411", counterparty_name: "Corner Shop",
      counterparty_iban: "NL91ABNA0417164300", counterparty_bic: "ABNANL2A", own_account: false,
      counterparty_ids: [{ identification: "shop-1", scheme_name: "OTHER" }], own_side_ids: [{ identification: "card-9" }] });
  });

  it("takes the debtor and recognises an own account when money arrives", () => {
    const result = normalizeBankTransaction(tx({ credit_debit_indicator: "CRDT", creditor: { name: "Me" }, debtor: { name: "My Savings" },
      debtor_account: { iban: "de89 3704 0044 0532 0130 00" }, bank_transaction_code: { code: "PMNT", sub_code: "RCDT/ESCT" } }), own);
    expect(result).toMatchObject({ payment_type: "transfer", counterparty_name: "My Savings", counterparty_iban: "DE89370400440532013000", own_account: true });
  });

  it("keeps the instructed amount and rate as text context, and ignores junk", () => {
    const result = normalizeBankTransaction(tx({ exchange_rate: { exchange_rate: "1.0834", instructed_amount: { amount: "108.34", currency: "USD" } } }));
    expect(result).toMatchObject({ instructed_amount: "108.34", instructed_currency: "USD", exchange_rate: "1.0834" });
    const junk = normalizeBankTransaction(tx({ exchange_rate: { exchange_rate: "lots", instructed_amount: { amount: "x", currency: "usd" } }, merchant_category_code: 5411 }));
    expect(junk).toMatchObject({ instructed_amount: null, instructed_currency: null, exchange_rate: null, mcc: null, payment_type: "unknown", counterparty_name: null });
  });

  it("parses references from every remittance line", () => {
    const result = normalizeBankTransaction(tx({ remittance_information: ["Gläubiger-ID DE98ZZZ09999999999", "Mandatsref M77"] }));
    expect(result).toMatchObject({ creditor_id: "DE98ZZZ09999999999", mandate_ref: "M77" });
  });
});

describe("raw JSON", () => {
  it("keeps the bank's transaction as received", () => {
    const received = tx({ note: "hello", extra: { nested: [1, 2] } });
    expect(boundedRaw(received)).toEqual(received);
  });

  it("is bounded and never carries a NUL byte", () => {
    const huge = tx({ note: "x".repeat(40_000), remittance_information: ["a".repeat(900), "b\u0000c"], merchant_category_code: "5411" });
    const raw = boundedRaw(huge);
    expect(Buffer.byteLength(JSON.stringify(raw))).toBeLessThan(16_001);
    expect(raw).toMatchObject({ truncated: true, merchant_category_code: "5411", entry_reference: "e1" });
    expect(JSON.stringify(boundedRaw(tx({ note: "a\u0000b" })))).not.toContain("\u0000");
  });
});
