import { expect, it, vi } from "vitest";
import RecurringPage from "./page";
const reads: {table: string; columns?: string; orders: string[]; cursor?: string}[] = [];
let stored: {id: string; account_id: string; currency_code: string; cadence: string; normalized_label: string; status: string; recurring_series_transactions: {transaction_id: string}[]}[] = [];
const renderedText = (node: unknown): string => {
  if (Array.isArray(node)) return node.map(renderedText).join("");
  if (node && typeof node === "object" && "props" in node) return renderedText((node as {props: {children?: unknown}}).props.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
};
let postings: {id: string; posted_on: string; description: string; amount_minor: string; currency_code: string; account_id: string; merchant_id: null; version: number}[] = [];
vi.mock("@/lib/auth", () => ({requireWorkspace: async () => ({workspace: {id: "workspace", locale: "en-US"}, supabase: {
  from: (table: string) => {
    const read: typeof reads[number] = {table, orders: [], columns: ""}; reads.push(read);
    const query = {select: (columns: string) => {read.columns = columns; return query;}, eq: () => query, in: () => query, is: () => query,
      order: (column: string) => {read.orders.push(column); return query;}, limit: () => query,
      or: (cursor: string) => {read.cursor = cursor; return query;},
      range: async (from: number, to: number) => {
        let data = table === "transactions" ? postings : [];
        if (read.cursor) { const [date, id] = [read.cursor.match(/posted_on.lt.([0-9-]+)/)![1], read.cursor.match(/id.lt.([^)]*)/)![1]]; data = data.filter(row => row.posted_on < date || row.posted_on === date && row.id < id); }
        return {data: data.slice(from, to + 1), error: null};
      }, then: (resolve: (value: unknown) => unknown) => Promise.resolve({data: table === "recurring_series" ? stored : [], error: null}).then(resolve)};
    return query;
  },
}})}));
it("reads recurring history by date then identity and supplies recorded merchant evidence", async () => {
  await RecurringPage();
  const history = reads.find(read => read.table === "transactions")!;
  expect(history.orders).toEqual(["posted_on", "id"]);
  expect(history.columns).toContain("merchant_id");
  expect(history.columns).toContain("version");
});

it("keyset-pages more than 10,000 eligible postings and drops the whole boundary date", async () => {
  reads.length = 0;
  postings = Array.from({length: 10001}, (_, index) => ({id: String(10001-index).padStart(8, "0"), posted_on: index < 9999 ? "2026-10-07" : "2024-01-01", description: `Singleton ${index}`, amount_minor: "-1", currency_code: "EUR", account_id: "cash", merchant_id: null, version: 1}));
  const result = await RecurringPage();
  const pages = reads.filter(read => read.table === "transactions");
  expect(pages).toHaveLength(11);
  expect(pages.slice(1).every(read => read.cursor?.includes("posted_on.lt."))).toBe(true);
  const text = (node: unknown): string => {
    if (Array.isArray(node)) return node.map(text).join("");
    if (node && typeof node === "object" && "props" in node) return text((node as {props: {children?: unknown}}).props.children);
    return typeof node === "string" || typeof node === "number" ? String(node) : "";
  };
  const content = text(result);
  expect(content).toContain("2026-10-07 to 2026-10-07");
  expect(content).toContain("2024-01-01");
  expect(content).toContain("Older patterns may be absent");
  expect(content).toContain("Statement intervals, missing statements and account completeness are unknown");
});

it("recognizes an existing confirmed schedule through owned evidence after run keys change", async () => {
  postings = ["2026-03-01", "2026-02-01", "2026-01-01"].map((posted_on, index) => ({id: `rent-${index}`, posted_on, description: "Rent", amount_minor: "-1000", account_id: "cash", currency_code: "EUR", merchant_id: null, version: 0}));
  stored = [{id: "existing", account_id: "cash", currency_code: "EUR", cadence: "monthly", normalized_label: "rent", status: "confirmed", recurring_series_transactions: [{transaction_id: "rent-0"}]}];
  const text = renderedText(await RecurringPage());
  expect(text).toContain("Confirmed");
  expect(text).not.toContain("confidence 70%");
});
