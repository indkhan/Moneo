import { expect, it } from "vitest";
import { loadConversation } from "./conversation-history";

const workspace = "owned";
const conversation = "00000000-0000-4000-8000-000000000001";
const [r1, r2, r3] = ["00000000-0000-4000-8000-0000000000a1", "00000000-0000-4000-8000-0000000000a2", "00000000-0000-4000-8000-0000000000a3"];
const at = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, "0")}+00:00`;
const base = { workspace_id: workspace, conversation_id: conversation };

// A typed chat before the call (r3), then two call requests (r1 answered, r2 still running), then the call record.
const tables: Record<string, Record<string, unknown>[]> = {
  conversations: [{ id: conversation, workspace_id: workspace, title: "T", created_at: at(0) }],
  messages: [
    { ...base, id: "u3", role: "user", content: "Typed question", created_at: at(1), request_id: r3, reply_to: null },
    { ...base, id: "a3", role: "assistant", content: "Typed answer", created_at: at(2), request_id: null, reply_to: r3 },
    { ...base, id: "u1", role: "user", content: "Netto?", created_at: at(10), request_id: r1, reply_to: null },
    { ...base, id: "a1", role: "assistant", content: "42 euros", created_at: at(11), request_id: null, reply_to: r1 },
    { ...base, id: "u2", role: "user", content: "Rent?", created_at: at(12), request_id: r2, reply_to: null },
    { ...base, id: "a2", role: "assistant", content: "1000 euros", created_at: at(40), request_id: null, reply_to: r2 },
  ],
  voice_calls: [{
    ...base, id: "call1", duration_seconds: 30, created_at: at(30), summary: "- Netto", summary_status: "done", request_ids: [r1, r2],
    transcript: [{ role: "user", text: "Netto?" }, { role: "assistant", text: "42" }],
    tasks: [{ requestId: r1, text: "Netto?", status: "done" }, { requestId: r2, text: "Rent?", status: "running" }],
  }, {
    ...base, id: "other-workspace", workspace_id: "foreign", duration_seconds: 5, created_at: at(31), summary: null, summary_status: "pending", request_ids: [r3], transcript: [], tasks: [],
  }],
  agent_proposals: [
    { id: "card1", workspace_id: workspace, chat_request_id: r1, kind: "transaction_create", created_at: at(11) },
    { id: "card-foreign", workspace_id: "foreign", chat_request_id: r1, kind: "transaction_create", created_at: at(11) },
    { id: "card-typed", workspace_id: workspace, chat_request_id: r3, kind: "transaction_create", created_at: at(2) },
  ],
  chat_requests: [{ id: r2, workspace_id: workspace, status: "completed", created_at: at(12) }],
};

function fake(data: typeof tables) {
  return { from(table: string) {
    let rows = [...(data[table] ?? [])];
    const query = {
      select: () => query, is: () => query, limit: () => query,
      eq: (key: string, value: string) => { rows = rows.filter(row => row[key] === value); return query; },
      in: (key: string, values: string[]) => { rows = rows.filter(row => values.includes(row[key] as string)); return query; },
      overlaps: (key: string, values: string[]) => { rows = rows.filter(row => (row[key] as string[]).some(item => values.includes(item))); return query; },
      gte: (key: string, value: string) => { rows = rows.filter(row => String(row[key]) >= value); return query; },
      lt: (key: string, value: string) => { rows = rows.filter(row => String(row[key]) < value); return query; },
      or: (filter: string) => { const ids = filter.match(/in\.\(([^)]*)\)/)?.[1].split(",") ?? []; rows = rows.filter(row => ids.includes(row.request_id as string) || ids.includes(row.reply_to as string)); return query; },
      order: (key: string, options?: { ascending: boolean }) => { rows.sort((a, b) => (options?.ascending === false ? -1 : 1) * String(a[key]).localeCompare(String(b[key]))); return query; },
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(resolve),
    };
    return query;
  } };
}

it("shows a finished call as one card and moves its request messages inside it", async () => {
  const { messages } = await loadConversation(fake(tables) as never, workspace, conversation);
  expect(messages.map(message => message.id)).toEqual(["u3", "a3", "call1"]);
  const card = messages.at(-1)!.call!;
  expect(card).toMatchObject({ id: "call1", durationSeconds: 30, summary: "- Netto", summaryStatus: "done" });
  expect(card.exchanges.map(item => item.id)).toEqual(["u1", "a1", "u2", "a2"]);
  expect(card.transcript).toHaveLength(2);
  // Only this workspace's cards made by this call's requests.
  expect(card.cards).toEqual(["card1"]);
  // A request still running at hang-up shows where it stands now.
  expect(card.unfinished).toEqual([{ text: "Rent?", status: "completed" }]);
  expect(messages.at(-1)).toMatchObject({ role: "assistant", content: "", created_at: at(30) });
});
it("keeps call messages in the chat until their call is recorded", async () => {
  const { messages } = await loadConversation(fake({ ...tables, voice_calls: [] }) as never, workspace, conversation);
  expect(messages.map(message => message.id)).toEqual(["u3", "a3", "u1", "a1", "u2", "a2"]);
});
