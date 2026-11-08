import { describe, expect, it } from "vitest";
import { brokerShownOn, matchTransfers, transitOn, type BankLeg, type BrokerTransfer } from "./transit";

const transfer = (provider_id: string, amount: number, on_date: string, over: Partial<BrokerTransfer> = {}): BrokerTransfer => ({ provider_id, type: amount > 0 ? "DEPOSIT" : "WITHDRAWAL", amount_minor: String(amount), currency_code: "EUR", on_date, occurred_at: `${on_date}T09:00:00Z`, status: "SETTLED", returns_provider_id: null, ...over });
const leg = (id: string, amount: number, postedOn: string, over: Partial<BankLeg> = {}): BankLeg => ({ id, accountId: "bank", amountMinor: BigInt(amount), currencyCode: "EUR", postedOn, transferId: null, provesBroker: true, ownAccount: false, ...over });
const run = (transfers: BrokerTransfer[], legs: BankLeg[], extra: Partial<Parameters<typeof matchTransfers>[0]> = {}) => matchTransfers({ transfers, legs, firstReal: "2030-01-01", reads: [], complete: true, coveredFrom: "2020-01-01", ...extra });
const addedOn = (windows: ReturnType<typeof run>["windows"], date: string) => transitOn(windows, date).get("EUR") ?? 0n;

describe("a transfer between tracked accounts", () => {
  it("is counted once on every day, whichever side lands first and however far apart", () => {
    // Bank and broker balances replayed from the two sides, with any two dates inside the window.
    const days = ["2026-06-01", "2026-06-02", "2026-06-03", "2026-06-04", "2026-06-05"];
    for (const brokerDay of days) for (const bankDay of days) {
      if (Math.abs(Date.parse(brokerDay) - Date.parse(bankDay)) > 3 * 86400000) continue;
      const { windows, unresolved } = run([transfer("T", 50000, brokerDay)], [leg("B", -50000, bankDay)]);
      expect(unresolved).toEqual([]);
      for (const day of days) {
        const broker = day >= brokerDay ? 50000n : 0n, bank = day >= bankDay ? -50000n : 0n;
        expect(broker + bank + addedOn(windows, day)).toBe(0n);
      }
    }
  });

  it("holds for bank to bank too, using the existing link", () => {
    const { windows } = run([], [leg("a", -50000, "2026-08-17", { transferId: "b", accountId: "commerz", provesBroker: false }), leg("b", 50000, "2026-08-15", { transferId: "a", accountId: "revolut", provesBroker: false })]);
    expect(windows).toMatchObject([{ kind: "linked", from: "2026-08-15", to: "2026-08-17", amountMinor: -50000n, broker: false }]);
    expect(windows).toHaveLength(1);
    expect(addedOn(windows, "2026-08-14")).toBe(0n);
    expect(addedOn(windows, "2026-08-16")).toBe(-50000n);
    expect(addedOn(windows, "2026-08-17")).toBe(0n);
  });

  it("leaves a linked pair's fee as a real change, and doesn't compare currencies", () => {
    const { windows } = run([], [leg("a", -50000, "2026-08-15", { transferId: "b", provesBroker: false }), leg("b", 49500, "2026-08-17", { transferId: "a", accountId: "other", provesBroker: false })]);
    expect(windows[0].amountMinor).toBe(49500n);
    expect(run([], [leg("a", -50000, "2026-08-15", { transferId: "b", provesBroker: false }), leg("b", 58000, "2026-08-17", { transferId: "a", currencyCode: "USD", provesBroker: false })]).windows).toEqual([]);
  });
});

describe("a returned withdrawal", () => {
  it("changes nothing on any day, with no bank row needed, even when it takes days to come back", () => {
    const out = transfer("W", -100000, "2026-06-12"), back = transfer("RETURN-W", 100000, "2026-06-15", { returns_provider_id: "W" });
    const { windows, unresolved } = run([out, back], []);
    expect(unresolved).toEqual([]);
    for (const day of ["2026-06-11", "2026-06-12", "2026-06-13", "2026-06-14", "2026-06-15", "2026-06-16"]) {
      const records = (day >= "2026-06-12" ? -100000n : 0n) + (day >= "2026-06-15" ? 100000n : 0n);
      expect(records + addedOn(windows, day)).toBe(0n);
    }
  });

  it("can't take a bank row meant for a real withdrawal of the same amount", () => {
    const { windows } = run([transfer("A", -170000, "2026-06-12"), transfer("RETURN-A", 170000, "2026-06-15", { returns_provider_id: "A" }), transfer("B", -170000, "2026-06-15")], [leg("in", 170000, "2026-06-16")]);
    expect(windows.map(item => [item.kind, item.from, item.to, item.amountMinor])).toEqual([["returned", "2026-06-12", "2026-06-15", 170000n], ["matched", "2026-06-15", "2026-06-16", 170000n]]);
  });

  it("the same day has no window", () => {
    expect(run([transfer("W", -100, "2026-03-09"), transfer("RETURN-W", 100, "2026-03-09", { returns_provider_id: "W" })], []).windows).toEqual([]);
  });
});

describe("proof", () => {
  it("won't match an equal amount in an account that isn't proven the broker's", () => {
    const friend = leg("friend", 40000, "2026-08-25", { provesBroker: false, ownAccount: false });
    expect(run([transfer("W", -40000, "2026-08-24")], [friend])).toMatchObject({ windows: [], unresolved: [{ key: "broker:W", reason: "missing" }] });
  });

  it("takes the proven row over an unrelated equal receipt on the same day", () => {
    const { windows } = run([transfer("W", -40000, "2026-08-24")], [leg("proven", 40000, "2026-08-25"), leg("revolut", 40000, "2026-08-25", { provesBroker: false, transferId: "c", accountId: "revolut" })]);
    expect(windows).toMatchObject([{ kind: "matched", accounts: ["bank"], from: "2026-08-24", to: "2026-08-25" }]);
  });

  it("accepts the bank row carrying the same note as the deposit", () => {
    const row = leg("note", -60000, "2026-11-02", { provesBroker: false, text: "To invest Sam Example DE00" });
    expect(run([transfer("D", 60000, "2026-11-01", { description: "To invest" })], [row]).windows).toHaveLength(1);
    // A word this short could be on anything.
    expect(run([transfer("D", 60000, "2026-11-01", { description: "stocks" })], [{ ...row, text: "stocks and more" }]).windows).toEqual([]);
  });

  it("stays unresolved, in both directions, when two candidates fit", () => {
    const { windows, unresolved } = run([transfer("W", -40000, "2026-08-24")], [leg("a", 40000, "2026-08-25"), leg("b", 40000, "2026-08-26")]);
    expect(windows).toEqual([]);
    expect(unresolved.map(item => [item.key, item.reason])).toEqual(expect.arrayContaining([["broker:W", "ambiguous"], ["bank:a", "ambiguous"], ["bank:b", "ambiguous"]]));
    const two = run([transfer("A", -40000, "2026-08-24"), transfer("B", -40000, "2026-08-25")], [leg("a", 40000, "2026-08-25")]);
    expect(two.windows).toEqual([]);
    expect(two.unresolved.filter(item => item.reason === "ambiguous").length).toBe(3);
  });

  it("never reuses a side, and leaves a side past the window listed without counting it", () => {
    const { windows, unresolved } = run([transfer("W", -40000, "2026-08-20")], [leg("late", 40000, "2026-08-24")]);
    expect(windows).toEqual([]);
    expect(unresolved.map(item => item.key).sort()).toEqual(["bank:late", "broker:W"]);
  });
});

describe("unresolved transfers", () => {
  it("stay visible with the total left as is, and correct earlier days once the other side lands", () => {
    const deposit = transfer("D", 60000, "2026-11-01");
    const first = run([deposit], []);
    expect(first.windows).toEqual([]);
    expect(first.unresolved).toMatchObject([{ key: "broker:D", amountMinor: 60000n, reason: "missing" }]);
    const later = run([deposit], [leg("b", -60000, "2026-11-02")]);
    expect(later.unresolved).toEqual([]);
    expect(addedOn(later.windows, "2026-11-01")).toBe(-60000n);
    expect(addedOn(later.windows, "2026-11-02")).toBe(0n);
  });

  it("don't list a broker transfer older than the bank data, or a bank row until the whole list was read", () => {
    expect(run([transfer("old", 100, "2020-01-01")], [], { coveredFrom: "2024-12-05" }).unresolved).toEqual([]);
    expect(run([], [leg("b", -100, "2026-01-01")], { complete: false }).unresolved).toEqual([]);
  });

  it("leave money to a bank Moneo doesn't track on its own date, unlisted, as a transfer with no tracked side", () => {
    expect(run([], [leg("elsewhere", -100, "2026-01-01", { provesBroker: false, ownAccount: false })])).toEqual({ windows: [], unresolved: [] });
    expect(run([], [leg("tracked", -100, "2026-01-01", { provesBroker: false, ownAccount: true })]).unresolved).toMatchObject([{ key: "bank:tracked" }]);
  });

  it("ignore pending and cancelled broker rows", () => {
    expect(run([transfer("P", 100, "2026-01-01", { status: "PENDING" }), transfer("C", 100, "2026-01-01", { is_cancellation: true })], [])).toEqual({ windows: [], unresolved: [] });
  });
});

describe("the first real sync", () => {
  const reads = [{ as_of: "2026-11-07", created_at: "2026-11-07T10:00:00Z" }, { as_of: "2026-11-08", created_at: "2026-11-08T10:00:00Z" }];
  const firstReal = "2026-11-07";

  it("uses the transfer's own date before it, and the first read after it from then on", () => {
    expect(brokerShownOn({ on_date: "2026-11-06", occurred_at: "2026-11-06T09:00:00Z" }, firstReal, reads)).toBe("2026-11-06");
    expect(brokerShownOn({ on_date: "2026-11-07", occurred_at: "2026-11-07T09:00:00Z" }, firstReal, reads)).toBe("2026-11-07");
    expect(brokerShownOn({ on_date: "2026-11-07", occurred_at: "2026-11-07T12:00:00Z" }, firstReal, reads)).toBe("2026-11-08");
    expect(brokerShownOn({ on_date: "2026-11-09", occurred_at: "2026-11-09T12:00:00Z" }, firstReal, reads)).toBeNull();
  });

  // Bank, calculated history and real value replayed around the seam: the money must count once on every day.
  const days = ["2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09"];
  const brokerValue = (day: string, onDate: string, amount: bigint) => day < firstReal ? (day >= onDate ? amount : 0n) : (onDate < firstReal || day >= (brokerShownOn({ on_date: onDate, occurred_at: `${onDate}T12:00:00Z` }, firstReal, reads) ?? "9999") ? amount : 0n);

  it("doesn't double count a deposit whose sides fall on either side of it, in any order", () => {
    for (const brokerDay of ["2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"]) for (const bankDay of ["2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08"]) {
      if (Math.abs(Date.parse(brokerDay) - Date.parse(bankDay)) > 3 * 86400000) continue;
      const { windows } = matchTransfers({ transfers: [transfer("D", 60000, brokerDay, { occurred_at: `${brokerDay}T12:00:00Z` })], legs: [leg("b", -60000, bankDay)], firstReal, reads, complete: true, coveredFrom: "2020-01-01" });
      for (const day of days) {
        const bank = day >= bankDay ? -60000n : 0n;
        expect(`${brokerDay} ${bankDay} ${day}: ${brokerValue(day, brokerDay, 60000n) + bank + addedOn(windows, day)}`).toBe(`${brokerDay} ${bankDay} ${day}: 0`);
      }
    }
  });

  it("keeps the money counted while no read has seen the broker side yet, today included", () => {
    const { windows } = matchTransfers({ transfers: [transfer("D", 60000, "2026-11-09", { occurred_at: "2026-11-09T12:00:00Z" })], legs: [leg("b", -60000, "2026-11-09")], firstReal, reads, complete: true, coveredFrom: "2020-01-01" });
    expect(addedOn(windows, "2026-11-09")).toBe(60000n);
  });
});
