import { expect, it } from "vitest";
import { suggestAccountName } from "./naming";

it("suggests bank, product and IBAN tail for imported file-stem names", () => {
  expect(suggestAccountName("account-statement_2025-11-05_2025-11-05_en_4b1f2a · Current")).toBe("Revolut Current");
  expect(suggestAccountName("account-statement_2025-11-05_en · DE89 3704 0044 0532 0130 00 · Savings")).toBe("Revolut Savings ••3000");
  expect(suggestAccountName("umsaetze_2025-10 · DE89370400440532013000")).toBe("Umsaetze ••3000");
  expect(suggestAccountName("export_2025-01-01.csv")).toBe("Export");
  expect(suggestAccountName("2025-01-01")).toBe("Imported account");
});

it("leaves names the user chose alone", () => {
  expect(suggestAccountName("Joint checking")).toBeNull();
  expect(suggestAccountName("Revolut Current")).toBeNull();
});
