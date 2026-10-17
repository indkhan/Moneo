import { expect, it, vi } from "vitest";
import { POST } from "@/app/api/imports/inspect/route";
import { generateObject } from "ai";
import { settingsSchema } from "@/lib/settings";

vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({ workspace: { display_currency: "EUR" }, settings: settingsSchema.parse({ ai_data_scopes: [] }) }) }));
vi.mock("@/lib/ai/provider", () => ({ getModel: vi.fn() }));
vi.mock("ai", () => ({ generateObject: vi.fn() }));

it.each([
  {
    format: "Revolut",
    csv: "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\nCard Payment,Current,2026-09-01 12:00:00,2026-09-01 12:00:00,Shop,-12.50,0.00,EUR,COMPLETED,100.00",
    mapping: { dateColumn: "Completed Date", dateFormat: "iso", productColumn: "Product", typeColumn: "Type", feeColumn: "Fee", statusColumn: "State" },
  },
  {
    format: "bank",
    csv: "Booking date,Value date,Transaction type,Booking text,Amount,Currency,Account IBAN,Category,Sender,Recipient,Transfer purpose\n01.09.2026,01.09.2026,Debit,Shop,-12.50,EUR,SYNTHETIC,Food,,,",
    mapping: { dateColumn: "Booking date", dateFormat: "dmy", accountColumn: "Account IBAN", typeColumn: "Transaction type", categoryColumn: "Category" },
  },
])("inspects supported $format statements without a provider request or AI permission", async ({ csv, mapping }) => {
  const form = new FormData();
  form.set("file", new File([csv], "synthetic.csv"));
  const response = await POST(new Request("http://localhost/api/imports/inspect", { method: "POST", body: form }));
  expect(response.status).toBe(200);
  const result = await response.json();
  expect(result.mapping).toMatchObject({ ...mapping, amountColumn: "Amount", currencyColumn: "Currency", amountSign: "signed" });
  expect(result.mapping.accountRoutes).toHaveLength(1);
  expect(result.preview).toMatchObject({ acceptedRows: 1, classificationReviewRows: 0 });
  expect(result.preview.examples[0].amountMinor).toBe("-1250");
  expect(result.aiError).toBeUndefined();
  expect(generateObject).not.toHaveBeenCalled();
});

it("serializes all mapped money including fee evidence in the real inspect response", async () => {
  const form = new FormData();
  form.set("file", new File(["Date,Description,Amount,Balance,Type,Fee\n2026-09-01,Shop,-12.50,100.00,Card Payment,2.00"], "synthetic.csv"));
  form.set("mapping", JSON.stringify({ accountName: "Cash", currencyCode: "EUR", dateColumn: "Date", descriptionColumn: "Description", amountColumn: "Amount", balanceColumn: "Balance", dateFormat: "iso", amountSign: "signed" }));
  const response = await POST(new Request("http://localhost/api/imports/inspect", { method: "POST", body: form }));
  expect(response.status).toBe(200);
  expect((await response.json()).preview.examples[0]).toMatchObject({ amountMinor: "-1250", balanceMinor: "10000", feeMinor: "200" });
});
