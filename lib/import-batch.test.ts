import { expect, it } from "vitest";
import { batchDecisions, stageImportRows } from "./import-batch";

it("stages exact financial payloads and exclusions in source order with explicit bounds", () => {
  const mapped = { rowNumber: 3, accountName: "Checking", currencyCode: "EUR", postedOn: "2026-10-01", description: "large", amountMinor: 9007199254740993n, status: "posted" as const, kind: "ordinary" as const, reviewReasons: [], sourceRow: { Amount: "90071992547409.93" } };
  const rows = stageImportRows("workspace", "import", [mapped], [{ rowNumber: 2, sourceRow: { Amount: "bad" }, reason: "Reviewed exclusion" }], new Map([[JSON.stringify(["Checking", "EUR"]), "account"]]), 2);
  expect(rows.map(row => row.row.rowNumber)).toEqual([2, 3]);
  expect(rows[1].row.amountMinor).toBe("9007199254740993");
  expect(JSON.stringify(rows)).toContain("9007199254740993");
  expect(() => stageImportRows("workspace", "import", [mapped], [], new Map(), 2)).toThrow("coverage");
});

it("keeps matching decisions tied to the prefetched canonical version", () => {
  const decisions = batchDecisions([{ rowNumber: 2, hasExternalId: true, status: "posted", candidates: [{ id: "canonical", stableExternalMatch: true, status: "posted", version: 7 }] }]);
  expect(decisions).toEqual([{ rowNumber: 2, action: "matched", transactionId: "canonical", expectedTransactionVersion: 7 }]);
  expect(batchDecisions([{ rowNumber: 3, hasExternalId: true, status: "pending", candidates: [{ id: "canonical", stableExternalMatch: true, status: "posted", version: 7 }] }])[0].action).toBe("review");
});

it("accepts the uncorrected canonical version zero used by the ledger", () => {
  expect(batchDecisions([{ rowNumber: 2, hasExternalId: true, status: "posted", candidates: [{ id: "canonical", stableExternalMatch: true, status: "posted", version: 0 }] }])).toEqual([{ rowNumber: 2, action: "matched", transactionId: "canonical", expectedTransactionVersion: 0 }]);
});

it("matches bounded boolean evidence without repeating arbitrary legacy external-ID strings", () => {
  expect(batchDecisions([{ rowNumber: 2, hasExternalId: true, status: "posted", candidates: [{ id: "canonical", stableExternalMatch: true, status: "posted", version: 0 }] }])).toEqual([{ rowNumber: 2, action: "matched", transactionId: "canonical", expectedTransactionVersion: 0 }]);
});
