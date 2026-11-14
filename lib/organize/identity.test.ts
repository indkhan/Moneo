import { describe, expect, it } from "vitest";
import { identityCandidate, looksLikePerson, type IdentityContext } from "./identity";

const raw = (over: Partial<IdentityContext> = {}): IdentityContext => ({ payment_type: "transfer", counterparty_name: null, counterparty_iban: null,
  counterparty_ids: [], own_side_ids: [], creditor_id: null, own_account: false, ...over });
const strongest = (description: string, context?: IdentityContext) => identityCandidate(description, context)?.aliases[0];

describe("identityCandidate", () => {
  it("gives different spellings of one merchant the same name alias", () => {
    const a = identityCandidate("Card payment 4411", raw({ payment_type: "card", counterparty_name: "Synthetic Grocer GmbH" }));
    const b = identityCandidate("POS 9921", raw({ payment_type: "card", counterparty_name: "SYNTHETIC GROCER" }));
    expect(a?.aliases[0]).toEqual({ type: "card_merchant", value: "synthetic grocer" });
    expect(b?.aliases[0]).toEqual(a?.aliases[0]);
  });

  it("puts the creditor id before the name, so a renamed direct debit stays one identity", () => {
    const context = raw({ payment_type: "direct_debit", creditor_id: "DE00ZZZ00000000001", counterparty_name: "Example Telecom AG" });
    expect(identityCandidate("Mobile plan October", context)?.aliases.map(alias => alias.type)).toEqual(["creditor_id", "counterparty_name", "description_key"]);
    expect(strongest("Rechnung 2026-10", { ...context, counterparty_name: "Example Mobile GmbH" })).toEqual({ type: "creditor_id", value: "DE00ZZZ00000000001" });
  });

  it("splits processor rows by description and never by the processor alone", () => {
    const paypal = raw({ payment_type: "direct_debit", counterparty_name: "PayPal Europe S.a.r.l. et Cie S.C.A", creditor_id: "LU00ZZZ0000000000000000001" });
    const music = identityCandidate("PayPal Europe 1040563 PP.9284.PP Ihr Einkauf bei Synthetic Music AB", paypal);
    const games = identityCandidate("PayPal Europe 1040564 PP.9285.PP Ihr Einkauf bei Synthetic Games", paypal);
    expect(music?.kind).toBe("processor");
    expect(music?.aliases).toEqual([{ type: "description_key", value: "paypal:ihr einkauf bei synthetic music" }]);
    expect(games?.aliases[0].value).not.toBe(music?.aliases[0].value);
    // Nothing but the processor and references: no identity at all.
    expect(identityCandidate("PayPal Europe S.a.r.l. et Cie S.C.A 1040565 PP.9286.PP", paypal)).toBeNull();
    expect(identityCandidate("PAYPAL *SYNTHETICSHOP", undefined)?.aliases).toEqual([{ type: "description_key", value: "paypal:syntheticshop" }]);
  });

  it("tells people from companies", () => {
    const cases: [string, boolean][] = [["Erika Mustermann", true], ["Jean-Luc Exemple", true], ["Synthetic Bakery GmbH", false], ["Muster e.K.", false],
      ["Example Holdings Ltd", false], ["Stadtwerke Beispiel", false], ["Mueller & Soehne", false], ["Prince", false], ["Example Trading B.V.", false]];
    for (const [name, person] of cases) expect([name, looksLikePerson(name)]).toEqual([name, person]);
    expect(identityCandidate("Dinner", raw({ counterparty_name: "Erika Mustermann", counterparty_iban: "DE75512108001245126199" }))).toEqual(
      { kind: "person", displayName: "Erika Mustermann", aliases: [{ type: "iban", value: "DE75512108001245126199" }, { type: "counterparty_name", value: "erika mustermann" }] });
    // A card payment under a person-like name is a shop, and so is a transfer with the card's id on it.
    expect(identityCandidate("Coffee", raw({ payment_type: "card", counterparty_name: "Erika Mustermann" }))?.kind).toBe("merchant");
    expect(identityCandidate("Coffee", raw({ counterparty_name: "Erika Mustermann", own_side_ids: [{ identification: "card-1" }] }))?.kind).toBe("merchant");
  });

  it("marks moves with nobody on the other side as internal", () => {
    expect(identityCandidate("To EUR MB:1234", raw())).toMatchObject({ kind: "internal", aliases: [{ type: "description_key", value: "to eur mb" }] });
  });
});
