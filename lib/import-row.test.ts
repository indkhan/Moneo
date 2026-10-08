import { expect, it } from "vitest";
import { mapRows } from "@/lib/csv";
import { importRowPayload } from "@/lib/import-row";

it("truncates imported merchant names at Unicode character boundaries", () => {
  const merchant = "x".repeat(99) + "🛒" + "extra";
  const original = { Date: "2026-10-09", Description: "Synthetic purchase", Amount: "-1.00", Merchant: merchant };
  const [mapped] = mapRows([original], { accountName: "Checking", currencyCode: "EUR", dateColumn: "Date", descriptionColumn: "Description", amountColumn: "Amount", merchantColumn: "Merchant", dateFormat: "iso", amountSign: "signed", numericConvention: "decimal-dot" });
  const row = importRowPayload("workspace", "import", mapped);
  expect(row.merchantName).toBe("x".repeat(99) + "🛒");
  expect(row.originalRow).toEqual(original);
});

it("serializes corrected normalized rows with original balance boundary and adjacent fee evidence", () => {
  const original = [{ Date: "2026-09-01T07:00:00Z", Description: "Opening", Amount: "1", Balance: "100", Fee: "0", Type: "Card payment" },
    { Date: "bad", Description: "amzn refund", Amount: "2", Balance: "102", Fee: "0,50", Type: "Card refund" }];
  const rows = mapRows(original, { accountName: "Original name", currencyCode: "EUR", dateColumn: "Date", descriptionColumn: "Description", amountColumn: "Amount", balanceColumn: "Balance", feeColumn: "Fee", typeColumn: "Type", dateFormat: "iso", amountSign: "signed", numericConvention: "decimal-comma", calendarTimezone: "Europe/Berlin", rowContractVersion: "normalized-row-v1", rowDecisions: [{ rowNumber: 3, action: "correct", values: { Date: "2026-09-01T10:00:00+02:00" } }] });
  const row = importRowPayload("workspace", "import", rows[1]);
  expect(row).toMatchObject({ accountName: "Original name", rowNumber: 3, postedAt: "2026-09-01T08:00:00.000Z", balanceAsOf: "2026-09-01T08:00:00.000Z", balanceMinor: "10200", kind: "refund", amountMinor: "200", feeEvidence: { treatment: "included", feeMinor: "50", deltaMinor: "200", previousRowNumber: 2 }, merchantName: "Amazon", originalRow: original[1] });
});
