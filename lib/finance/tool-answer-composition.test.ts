import { expect, it } from "vitest";
import { providerFinancialAnswer, toolResultReceipt } from "./tool-evidence";

const context = { workspaceId: "00000000-0000-4000-8000-000000000001", fetchedAt: "2026-10-01T12:00:00Z", timezone: "UTC" };
const transactionId = "00000000-0000-4000-8000-000000000002";
const categoryId = "00000000-0000-4000-8000-000000000003";
const blocked = toolResultReceipt("forecast_evaluate", {}, { status: "unavailable", missingInputs: ["fx:opening balance"] }, context, ["accounts", "transactions", "planning"]);
const statuses = [
  [toolResultReceipt("artifacts_create", {}, { id: transactionId }, context, []), "Created the requested tool"],
  [toolResultReceipt("reviews_start", {}, { status: "started" }, context, ["accounts", "transactions"]), "The requested review was started"],
  [toolResultReceipt("transactions_setCategory", { transactionId, category: "Food" }, { status: "updated", category: "Food", transactionUrl: `/money/transactions?transaction=${transactionId}` }, context, ["transactions"]), "Updated the selected transaction category"],
  [toolResultReceipt("transactions_previewCategory", { transactionIds: [transactionId], categoryId }, { rows: [{ id: transactionId }], category: { id: categoryId } }, context, ["transactions"]), "Preview only"],
  [toolResultReceipt("imports_status", {}, { imports: [{ id: transactionId, status: "completed" }] }, context, ["imports"]), "Recorded processing status: completed"],
  [toolResultReceipt("accounts_list", {}, [], context, ["accounts"]), "No account records were returned for this workspace"],
] as const;
const limitation = { action: "limitation", receiptId: blocked.id, limitationId: blocked.limitations![0].id };
const variants = [
  ["empty", { claims: [], interpretation: [] }, null],
  ["limitation only", { claims: [], interpretation: [limitation] }, null],
  ["greeting", { claims: [], interpretation: [], clarification: { topic: "welcome" } }, "Hello."],
  ["scope", { claims: [], interpretation: [limitation], clarification: { topic: "period" } }, "What start and end dates"],
] as const;

it.each(statuses)("renders a useful standalone %s status without a generic investigation prompt", (receipt, status) => {
  const result = providerFinancialAnswer(JSON.stringify({ claims: [], interpretation: [] }), [receipt], context.workspaceId);
  expect(result.body).toContain(status);
  expect(result.body).not.toContain("Tell me the financial question, dates and any account or category scope.");
});

for (const [receipt, status] of statuses) it.each(variants)(`keeps owned blockers beside ${status} with %s provider output`, (_name, answer, clarification) => {
  const result = providerFinancialAnswer(JSON.stringify(answer), [blocked, receipt], context.workspaceId);
  expect(result.accepted).toHaveLength(0);
  expect(result.removed).toBe(0);
  expect(result.body).toContain(status);
  expect(result.body.match(/fx:opening balance/g)).toHaveLength(1);
  expect(result.body).toContain("Consider reviewing the assumptions");
  expect(result.body).toContain(`/ai/evidence/${blocked.id}`);
  expect(result.body).toContain(`/ai/evidence/${receipt.id}`);
  expect(result.body).not.toContain("Tell me the financial question, dates and any account or category scope.");
  if (clarification) expect(result.body).toContain(clarification);
});

it.each(variants)("renders useful standalone blockers once without an unrelated generic prompt for %s", (_name, answer, clarification) => {
  const result = providerFinancialAnswer(JSON.stringify(answer), [blocked], context.workspaceId);
  expect(result.body.match(/fx:opening balance/g)).toHaveLength(1);
  expect(result.body).toContain("Consider reviewing the assumptions");
  expect(result.body).not.toContain("Tell me the financial question, dates and any account or category scope.");
  if (clarification) expect(result.body).toContain(clarification);
});

it("retains withholding notices and rejects forged blockers alongside successful actions", () => {
  const foreign = toolResultReceipt("forecast_evaluate", {}, { missingInputs: ["foreign secret"] }, { ...context, workspaceId: categoryId }, ["planning"]);
  const result = providerFinancialAnswer("EUR999999 [source](/invented)", [blocked, foreign, statuses[0][0]], context.workspaceId);
  expect(result.body.match(/fx:opening balance/g)).toHaveLength(1);
  expect(result.body).toContain("Created the requested tool");
  expect(result.body).toContain("Unsupported sections were removed");
  expect(result.body).not.toContain("999999");
  expect(result.body).not.toContain("/invented");
  expect(result.body).not.toContain("foreign secret");
  expect(result.body).not.toContain(`/ai/evidence/${foreign.id}`);
});

it("adds only missing blockers when one of several retained limitations is explicitly selected", () => {
  const second = toolResultReceipt("forecast_evaluate", {}, { missingInputs: ["Current booked balance unavailable"] }, context, ["accounts", "planning"]);
  const result = providerFinancialAnswer(JSON.stringify({ claims: [], interpretation: [limitation] }), [blocked, second, statuses[0][0]], context.workspaceId);
  expect(result.body.match(/fx:opening balance/g)).toHaveLength(1);
  expect(result.body.match(/Current booked balance unavailable/g)).toHaveLength(1);
  expect(result.body.match(/Interpretation — conditional next steps/g)).toHaveLength(1);
  expect(result.body).toContain("Created the requested tool");
});

it("publishes the verified empty account inventory when provider prose is unsupported", () => {
  const receipt = toolResultReceipt("accounts_list", {}, [], context, ["accounts"]);
  const result = providerFinancialAnswer("There are no accounts and your balance is zero.", [receipt], context.workspaceId);
  expect(result.body).toContain("No account records were returned for this workspace.");
  expect(result.body).toContain(`/ai/evidence/${receipt.id}`);
  expect(result.body).toContain("Unsupported sections were removed");
  expect(result.body).not.toContain("Tell me the financial question");
  expect(result.body).not.toContain("balance is zero");
  expect(result.accepted).toHaveLength(0);
});

it("does not infer an empty account inventory from foreign, unscoped or malformed results", () => {
  const receipts = [
    toolResultReceipt("accounts_list", {}, [], { ...context, workspaceId: categoryId }, ["accounts"]),
    toolResultReceipt("accounts_list", {}, [], context, []),
    ...[null, {}, { error: "unavailable" }, [{ id: transactionId }]].map(value => toolResultReceipt("accounts_list", {}, value, context, ["accounts"])),
  ];
  const result = providerFinancialAnswer(JSON.stringify({ claims: [], interpretation: [] }), receipts, context.workspaceId);
  expect(result.body).not.toContain("No account records");
});

const accounts = [
  { id: transactionId, name: "Checking QA", type: "checking", currency_code: "EUR", version: 1 },
  { id: categoryId, name: "Savings QA", type: "savings", currency_code: "EUR" },
];
it.each([120, 121])("validates account inventory names by Unicode code points at %s characters", length => {
  const name = "😀".repeat(length);
  const receipt = toolResultReceipt("accounts_list", {}, [{ ...accounts[0], name }], context, ["accounts"]);
  const result = providerFinancialAnswer(JSON.stringify({ claims: [], interpretation: [] }), [receipt], context.workspaceId);
  if (length === 120) expect(result.body).toContain(`- ${name}`);
  else expect(result.body).not.toContain("Recorded accounts");
  expect(result.accepted).toHaveLength(0);
});
it.each([JSON.stringify({ claims: [], interpretation: [] }), "Checking QA and Savings QA have zero balances."])("publishes only recorded account names from a nonempty inventory with %s provider output", text => {
  const receipt = toolResultReceipt("accounts_list", {}, accounts, context, ["accounts"]);
  const result = providerFinancialAnswer(text, [receipt], context.workspaceId);
  expect(result.body).toContain("Recorded accounts in this workspace:");
  expect(result.body).toContain("- Checking QA");
  expect(result.body).toContain("- Savings QA");
  expect(result.body).toContain(`/ai/evidence/${receipt.id}`);
  expect(result.body).not.toContain("Tell me the financial question");
  expect(result.body).not.toContain("zero balances");
  expect(result.accepted).toHaveLength(0);
});
it("escapes recorded account names without publishing links or injected sections", () => {
  const receipt = toolResultReceipt("accounts_list", {}, [{ ...accounts[0], name: "[Visit](https://example.invalid)\n# EUR999" }], context, ["accounts"]);
  const result = providerFinancialAnswer(JSON.stringify({ claims: [], interpretation: [] }), [receipt], context.workspaceId);
  expect(result.body).toContain("- \\[Visit\\]\\(https://example.invalid\\) \\# EUR999");
  expect(result.body).not.toContain("[Visit](https://example.invalid)");
  expect(result.accepted).toHaveLength(0);
});
it("rejects foreign, unscoped and malformed nonempty account inventories", () => {
  const receipts = [
    toolResultReceipt("accounts_list", {}, accounts, { ...context, workspaceId: categoryId }, ["accounts"]),
    toolResultReceipt("accounts_list", {}, accounts, context, []),
    ...[{ ...accounts[0], id: "bad" }, { ...accounts[0], name: "" }, { ...accounts[0], type: "fake" }, { ...accounts[0], currency_code: "bad" }, { ...accounts[0], version: 0 }]
      .map(row => toolResultReceipt("accounts_list", {}, [accounts[1], row], context, ["accounts"])),
  ];
  const result = providerFinancialAnswer(JSON.stringify({ claims: [], interpretation: [] }), receipts, context.workspaceId);
  expect(result.body).not.toContain("Recorded accounts");
  expect(result.body).not.toContain("Checking QA");
  expect(result.body).not.toContain("Savings QA");
});
