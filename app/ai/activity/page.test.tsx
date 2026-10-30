import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const tables: string[] = [];
const rows: Record<string, unknown[]> = {
  imports: [
    { id: "i1", filename: "failed.csv", status: "failed", total_rows: 1, new_rows: 0, matched_rows: 0, review_rows: 0, classification_review_rows: 0, rejected_rows: 0, error: "Bad file", created_at: "2026-10-02T10:00:00Z" },
    { id: "i2", filename: "fine.csv", status: "completed", total_rows: 2, new_rows: 2, matched_rows: 0, review_rows: 0, classification_review_rows: 0, rejected_rows: 0, error: null, created_at: "2026-10-01T10:00:00Z" },
  ],
  chat_requests: [{ id: "c1", conversation_id: "x", status: "completed", error: null, usage: null, answer: "Done", updated_at: "2026-10-03T10:00:00Z" }],
};
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({ workspace: { id: "w", locale: "en-US", timezone: "UTC" }, supabase: { from: (table: string) => {
  tables.push(table);
  const query: Record<string, unknown> = { then: (resolve: (value: unknown) => void) => resolve({ data: rows[table] ?? [], error: null }) };
  for (const method of ["select", "eq", "neq", "in", "order", "limit"]) query[method] = () => query;
  return query;
} } }) }));

const { default: ActivityPage } = await import("./page");
const render = async (filter?: string) => renderToStaticMarkup(await ActivityPage({ searchParams: Promise.resolve({ filter }) }));

it("filters the shared feed and queries only the sources a filter shows", async () => {
  const all = await render();
  expect(all).toContain("fine.csv");
  expect(all).not.toContain("Chat reply completed");
  const attention = await render("attention");
  expect(attention).toContain("failed.csv");
  expect(attention).not.toContain("fine.csv");
  tables.length = 0;
  expect(await render("imports")).toContain("fine.csv");
  expect(tables).toEqual(["imports"]);
  expect(await render("chats")).toContain("Chat reply completed");
});

it("flags a chat reply whose cards are still open, even after the user left before it finished", async () => {
  const card = "00000000-0000-4000-8000-000000000010", decided = "00000000-0000-4000-8000-000000000011";
  rows.chat_requests.push({ id: "c2", conversation_id: "y", status: "completed", error: null, usage: null, updated_at: "2026-10-04T10:00:00Z",
    answer: ["Added.", "```moneo-proposals", JSON.stringify([card, decided]), "```"].join(String.fromCharCode(10)) });
  rows.agent_proposals = [{ id: card }];
  try {
    const attention = await render("attention");
    expect(attention).toContain("Chat reply · 1 card waiting for you");
    expect(attention).toContain("/ai?conversation=y");
    expect(attention).not.toContain("Chat reply completed");
  } finally { rows.chat_requests.pop(); delete rows.agent_proposals; }
});
