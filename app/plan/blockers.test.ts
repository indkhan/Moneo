import { describe, expect, it, vi } from "vitest";
import { forecastBlockers } from "./blockers";

vi.mock("next/link", () => ({ default: "a" }));

const accounts = [{ id: "revolut" }, { id: "n26" }];
const names = new Map([["revolut", "Revolut"], ["n26", "N26"]]);

describe("forecastBlockers", () => {
  it("gives an account one line, its most important problem and its own balance link", () => {
    const [line, ...rest] = forecastBlockers(["balance:revolut:missing", "balance:revolut:ambiguous", "available-balance:revolut", "fx:assumption:revolut"], accounts, names);
    expect(rest).toEqual([]);
    expect(line).toMatchObject({ text: "Revolut: its balance sources disagree. Review which one is right.", action: "Review balance", href: "/money/accounts#account-revolut" });
  });

  it("tells a missing balance from an out-of-date one", () => {
    expect(forecastBlockers(["balance:revolut", "balance:n26:stale"], accounts, names).map(item => item.action)).toEqual(["Add balance", "Update balance"]);
  });

  it("sends each kind of gap to where it gets fixed", () => {
    const href = (key: string) => forecastBlockers([key], accounts, names)[0].href;
    expect(href("fx:assumption:n26")).toBe("/plan/currency");
    expect(href("debt:n26:terms")).toBe("/money/wealth");
    expect(href("rate:USD->EUR")).toBe("/plan/currency");
    expect(href("estimated spending account")).toBe("#forecast-preferences");
    expect(href("accounts")).toBe("/money/accounts");
  });

  it("does not read a scenario id as an account", () => {
    expect(forecastBlockers(["fx:scenario:abc"], accounts, names)[0]).toMatchObject({ href: "/plan/currency", action: "Add rate" });
  });
});
