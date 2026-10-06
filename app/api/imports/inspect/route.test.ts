import { afterEach, expect, it, vi } from "vitest";
import { POST } from "./route";
import { generateObject } from "ai";

vi.mock("ai", () => ({ generateObject: vi.fn() }));
vi.mock("@/lib/ai/provider", () => ({ modelForSettings: async () => ({}) }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({ workspace: { display_currency: "EUR" } }) }));
afterEach(() => vi.clearAllMocks());

it("returns an editable mapping when source money needs numeric clarification", async () => {
  const form = new FormData();
  form.set("file", new File(["Date,Description,Amount\n2026-10-01,Synthetic,1.234"], "synthetic.csv"));
  form.set("mapping", JSON.stringify({ accountName: "Cash", currencyCode: "KWD", dateColumn: "Date", descriptionColumn: "Description", amountColumn: "Amount", dateFormat: "iso", amountSign: "signed" }));
  const response = await POST(new Request("http://localhost/api/imports/inspect", { method: "POST", body: form }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ mapping: { currencyCode: "KWD" }, preview: null, previewError: expect.stringContaining("numeric convention") });
});

it("cancels provider mapping when the upload request is canceled", async () => {
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  vi.mocked(generateObject).mockImplementationOnce(async options => {
    started();
    await new Promise((_, reject) => options.abortSignal?.addEventListener("abort", () => reject(new Error("Mapping canceled")), { once: true }));
    throw new Error("Unreachable");
  });
  const form = new FormData();
  form.set("file", new File(["date,description,amount\n2026-10-01,Coffee,-2.00"], "bank.csv"));
  const response = POST(new Request("http://localhost/api/imports/inspect", { method: "POST", body: form, signal: controller.signal }));
  await ready;
  controller.abort();
  expect(await (await response).json()).toMatchObject({ mapping: null, aiError: "Mapping canceled" });
});

it.each([
  {
    filename: "revolut.csv",
    csv: "Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance\nCard Payment,Current,2026-09-01 10:00:00,2026-09-01 12:00:00,Shop,-12.50,0.00,EUR,COMPLETED,100.00",
    expected: { dateColumn: "Completed Date", descriptionColumn: "Description", productColumn: "Product", statusColumn: "State", balanceColumn: "Balance", typeColumn: "Type", feeColumn: "Fee", dateFormat: "iso", timestampTimezoneConfirmed: false },
  },
  {
    filename: "bank.csv",
    csv: "Booking date,Value date,Transaction type,Booking text,Amount,Currency,Account IBAN,Category,Sender,Recipient,Transfer purpose\n01.09.2026,01.09.2026,Card payment,Shop,-12.50,EUR,synthetic-account,Shopping,,,",
    expected: { dateColumn: "Booking date", descriptionColumn: "Booking text", categoryColumn: "Category", typeColumn: "Transaction type", accountColumn: "Account IBAN", dateFormat: "dmy" },
  },
])("previews $filename immediately without an AI mapping call", async ({ filename, csv, expected }) => {
  const form = new FormData();
  form.set("file", new File([csv], filename));
  const response = await POST(new Request("http://localhost/api/imports/inspect", { method: "POST", body: form }));
  const result = await response.json();
  expect(response.status).toBe(200);
  expect(result.mapping).toMatchObject({ ...expected, currencyColumn: "Currency", amountColumn: "Amount", amountSign: "signed" });
  expect(result.preview).toMatchObject({ totalRows: 1, examples: [{ amountMinor: "-1250", postedOn: "2026-09-01" }] });
  expect(generateObject).not.toHaveBeenCalled();
});
