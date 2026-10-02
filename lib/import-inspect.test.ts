import { expect, it, vi } from "vitest";
import { POST } from "@/app/api/imports/inspect/route";

vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({ workspace: { display_currency: "EUR" } }) }));
vi.mock("@/lib/ai/provider", () => ({ getModel: vi.fn() }));

it("serializes all mapped money including fee evidence in the real inspect response", async () => {
  const form = new FormData();
  form.set("file", new File(["Date,Description,Amount,Balance,Type,Fee\n2026-09-01,Shop,-12.50,100.00,Card Payment,2.00"], "synthetic.csv"));
  form.set("mapping", JSON.stringify({ accountName: "Cash", currencyCode: "EUR", dateColumn: "Date", descriptionColumn: "Description", amountColumn: "Amount", balanceColumn: "Balance", dateFormat: "iso", amountSign: "signed" }));
  const response = await POST(new Request("http://localhost/api/imports/inspect", { method: "POST", body: form }));
  expect(response.status).toBe(200);
  expect((await response.json()).preview.examples[0]).toMatchObject({ amountMinor: "-1250", balanceMinor: "10000", feeMinor: "200" });
});
