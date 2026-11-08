import { describe, expect, it } from "vitest";
import { closingPlan, closingTargets } from "./account-closing";

const uuid = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;
const account = { id: uuid(1), name: "Old bank", type: "checking", currency_code: "EUR" };
const savings = { id: uuid(2), name: "Savings", type: "savings", currency_code: "EUR" };
const cash = { id: uuid(3), name: "Wallet", type: "cash", currency_code: "EUR" };
const dollars = { id: uuid(4), name: "Dollars", type: "checking", currency_code: "USD" };
const closed = { id: uuid(5), name: "Closed", type: "checking", currency_code: "EUR", archived_at: "2026-01-01" };

describe("closing a balance", () => {
  it("offers only other live accounts in the same currency", () => {
    expect(closingTargets(account, [account, savings, cash, dollars, closed]).map(row => row.id)).toEqual([savings.id, cash.id]);
  });

  it("moves the money in two equal rows, so the total can't change", () => {
    const plan = closingPlan(account, 5000n, { outcome: "moved", targetAccountId: savings.id }, [account, savings]);
    expect(plan.out.amountMinor + plan.into!.amountMinor).toBe(0n);
    expect(plan).toMatchObject({ out: { amountMinor: -5000n }, into: { amountMinor: 5000n }, target: { id: savings.id }, createCash: false });
    // A negative balance moves the other way.
    expect(closingPlan(account, -5000n, { outcome: "moved", targetAccountId: savings.id }, [account, savings])).toMatchObject({ out: { amountMinor: 5000n }, into: { amountMinor: -5000n } });
    expect(() => closingPlan(account, 5000n, { outcome: "moved", targetAccountId: dollars.id }, [account, dollars])).toThrow("Choose another EUR");
  });

  it("takes it to the Cash account, makes one when there is none, and asks when there are several", () => {
    expect(closingPlan(account, 5000n, { outcome: "cash" }, [account, cash])).toMatchObject({ target: { id: cash.id }, createCash: false });
    expect(closingPlan(account, 5000n, { outcome: "cash" }, [account, savings])).toMatchObject({ target: null, createCash: true });
    const second = { ...cash, id: uuid(6), name: "Jar" };
    expect(() => closingPlan(account, 5000n, { outcome: "cash" }, [account, cash, second])).toThrow("Choose a Cash");
    expect(closingPlan(account, 5000n, { outcome: "cash", targetAccountId: second.id }, [account, cash, second])).toMatchObject({ target: { id: second.id } });
  });

  it("records money that is gone as money that left, with no other side", () => {
    expect(closingPlan(account, 5000n, { outcome: "gone" }, [account])).toMatchObject({ out: { amountMinor: -5000n }, into: null });
  });

  it("has nothing to do at zero", () => {
    expect(() => closingPlan(account, 0n, { outcome: "gone" }, [account])).toThrow("no money");
  });
});
