import { describe, expect, it } from "vitest";
import { loadConversation, loadConversationHistory, loadThreads } from "./conversation-history";

const workspace = "owned";
const rows = Array.from({ length: 1000 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, workspace_id: workspace, conversation_id: "00000000-0000-4000-8000-000000000000", title: `Thread ${i}`, content: `Message ${i}`, created_at: "2026-01-01T00:00:00+00:00" }));
function client(fail: boolean | "selected" | "messages" = false) {
  return { from(table: string) {
    let data = table === "voice_calls" ? [] : table === "messages" ? [...rows] : rows.slice(0, 100);
    const query = {
      select: () => query, is: () => query, gte: () => query, lt: () => query, overlaps: () => query,
      eq: (key: string, value: string) => { data = data.filter(row => row[key as keyof typeof row] === value); return query; },
      order: (key: string, options?: { ascending: boolean }) => { data.sort((a, b) => (options?.ascending === false ? -1 : 1) * (a[key as "id"].localeCompare(b[key as "id"]))); return query; },
      or: (filter: string) => { const id = filter.match(/id.lt.([0-9a-f-]+)/)?.[1]; const timestamp = filter.match(/created_at.lt.([^,]+)/)?.[1]; data = data.filter(row => row.created_at < timestamp! || (row.created_at === timestamp && row.id < id!)); return query; },
      limit: (n: number) => { data = data.slice(0, n); return query; },
      maybeSingle: async () => ({ data: data[0] ?? null, error: fail === true || fail === "selected" ? {} : null }),
      then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data, error: fail === true || (fail === "messages" && table === "messages") ? {} : null }).then(resolve),
    }; return query;
  } };
}
describe("saved conversation history", () => {
  it("directly loads the 100th thread and newest 30 of 1000 tied messages", async () => {
    const result = await loadConversationHistory(client() as never, workspace, rows[0].id);
    expect(result.selected?.id).toBe(rows[0].id);
    expect(result.messages.at(-1)?.content).toBe("Message 999");
    expect(result.messages[0].content).toBe("Message 970");
    expect(result.messagesCursor).toBeTruthy();
    expect(result.threads).toHaveLength(30);
  });
  it("pages tied rows without omissions or duplicates", async () => {
    let cursor: string | undefined; const ids: string[] = [];
    do { const result = await loadConversationHistory(client() as never, workspace, rows[0].id, undefined, cursor); ids.push(...result.messages.map(row => row.id)); cursor = result.messagesCursor ?? undefined; } while (cursor);
    expect(new Set(ids).size).toBe(1000); expect(ids).toHaveLength(1000);
  });
  it("reaches all 100 threads including the 31st across tied pages", async () => {
    let cursor: string | undefined; const ids: string[] = [];
    do { const result = await loadConversationHistory(client() as never, workspace, "new", cursor); ids.push(...result.threads.map(row => row.id)); cursor = result.threadsCursor ?? undefined; } while (cursor);
    expect(ids).toHaveLength(100); expect(new Set(ids).size).toBe(100);
    expect(ids[30]).toBe(rows[69].id); expect(ids[99]).toBe(rows[0].id);
  });
  it("pages 100 tied threads and keeps older pages stable after new arrivals", async () => {
    const first = await loadConversationHistory(client() as never, workspace, rows[0].id);
    const arrival = { ...rows[999], id: "00000000-0000-4000-8000-999999999999", created_at: "2026-02-01T00:00:00+00:00" };
    rows.unshift(arrival);
    try {
      const next = await loadConversationHistory(client() as never, workspace, "00000000-0000-4000-8000-000000000000", first.threadsCursor!, first.messagesCursor!);
      expect(next.threads.some(row => row.id === arrival.id)).toBe(false);
      expect(next.messages.some(row => row.id === arrival.id)).toBe(false);
      expect(next.messages).toHaveLength(30);
      const newest = await loadConversationHistory(client() as never, workspace, "00000000-0000-4000-8000-000000000000");
      expect(newest.messages.at(-1)?.id).toBe(arrival.id);
    } finally { rows.shift(); }
  });
  it("explicit New does not select a saved thread and malformed cursors fail", async () => {
    expect((await loadConversationHistory(client() as never, workspace, "new")).selected).toBeNull();
    const fresh = await loadConversationHistory(client() as never, workspace);
    expect(fresh.selected).toBeNull(); expect(fresh.messages).toEqual([]); expect(fresh.threads).toHaveLength(30);
    await expect(loadConversationHistory(client() as never, workspace, "new", "bad")).rejects.toThrow("Invalid history cursor");
  });
  it("never replaces a missing or foreign requested thread with New", async () => {
    await expect(loadConversationHistory(client() as never, "foreign", rows[0].id)).rejects.toThrow("Conversation unavailable");
    await expect(loadConversationHistory(client() as never, workspace, "00000000-0000-4000-8000-999999999999")).rejects.toThrow("Conversation unavailable");
  });
  it.each([true, "selected", "messages"] as const)("reports database failures at %s", async (failure) => {
    await expect(loadConversationHistory(client(failure) as never, workspace, rows[0].id)).rejects.toThrow("Could not load");
  });
});

it("pages every title and message match with an exact count and honours escaped wildcards", async () => {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const conversations = [
    ...Array.from({ length: 65 }, (_, n) => ({ id: id(n), title: `100%_rent* ${n}`, created_at: `2026-01-${String(1 + (n % 20)).padStart(2, "0")}T00:00:00+00:00`, deleted_at: null, artifact_id: null, workspace_id: workspace })),
    { id: id(100), title: "Landlord", created_at: "2026-01-05T00:00:00+00:00", deleted_at: null, artifact_id: null, workspace_id: workspace },
    { id: id(101), title: "1000 rent", created_at: "2026-01-05T00:00:00+00:00", deleted_at: null, artifact_id: null, workspace_id: workspace },
    { id: id(102), title: "100%_rent* gone", created_at: "2026-01-05T00:00:00+00:00", deleted_at: "2026-01-06T00:00:00+00:00", artifact_id: null, workspace_id: workspace },
  ];
  const messages = [
    { conversation_id: id(100), content: "about 100%_rent* again", created_at: "2026-01-05T00:00:00+00:00", workspace_id: workspace },
    { conversation_id: id(3), content: "100%_rent* also in text", created_at: "2026-01-05T00:00:00+00:00", workspace_id: workspace },
  ];
  const like = (pattern: string) => (text: string) => {
    const tokens = [...pattern.matchAll(/\\(.)|(%)|(_)|(.)/gs)].map(([, escaped, any, one, plain]) => any ? ".*" : one ? "." : (escaped ?? plain ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    return new RegExp(`^${tokens.join("")}$`, "is").test(text);
  };
  const fake = { from(table: string) {
    let data: Record<string, string | null>[] = table === "messages" ? [...messages] : [...conversations];
    let counted = false;
    const keys: string[] = [];
    const query = {
      select: (_: string, options?: { count?: string }) => { counted = !!options?.count; return query; },
      eq: (key: string, value: string) => { data = data.filter(row => row[key] === value); return query; },
      is: (key: string) => { data = data.filter(row => row[key] === null); return query; },
      in: (key: string, values: string[]) => { data = data.filter(row => values.includes(row[key] ?? "")); return query; },
      ilike: (key: string, pattern: string) => { data = data.filter(row => like(pattern)(row[key] ?? "")); return query; },
      not: (key: string, _: string, pattern: string) => { data = data.filter(row => !like(pattern)(row[key] ?? "")); return query; },
      order: (key: string) => { keys.push(key); return query; },
      or: (filter: string) => { const [, at, after] = filter.match(/created_at.lt.([^,]+),.*id.lt.([0-9a-f-]+)/) ?? []; data = data.filter(row => (row.created_at ?? "") < (at ?? "") || (row.created_at === at && (row.id ?? "") < (after ?? ""))); return query; },
      limit: (n: number) => { const total = data.length; data.sort((a, b) => keys.reduce((order, key) => order || (b[key] ?? "").localeCompare(a[key] ?? ""), 0)); data = data.slice(0, n); return Object.assign(Promise.resolve({ data, error: null, count: counted ? total : null }), query); },
    };
    return query;
  } };
  const ids: string[] = [];
  const totals: number[] = [];
  let cursor: string | undefined;
  do {
    const page = await loadThreads(fake as never, workspace, cursor, " 100%_rent* ");
    expect(page.threads.length).toBeLessThanOrEqual(30);
    ids.push(...page.threads.map(thread => thread.id)); totals.push(page.total ?? -1);
    cursor = page.threadsCursor ?? undefined;
  } while (cursor);
  expect(totals[0]).toBe(66);
  expect(ids).toHaveLength(66);
  expect(new Set(ids)).toEqual(new Set([...Array.from({ length: 65 }, (_, n) => id(n)), id(100)]));
});

describe("saved answer activity", () => {
  it("joins each answer to its owned chat request's plan and tool calls", async () => {
    const conversation = "00000000-0000-4000-8000-000000000001";
    const tables: Record<string, Record<string, unknown>[]> = {
      conversations: [{ id: conversation, workspace_id: workspace, title: "T", created_at: "2026-01-01T00:00:00+00:00" }],
      messages: [
        { id: "m1", workspace_id: workspace, conversation_id: conversation, role: "user", content: "Q", created_at: "2026-01-01T00:00:01+00:00", reply_to: null, context: { input: "voice" } },
        { id: "m2", workspace_id: workspace, conversation_id: conversation, role: "assistant", content: "A", created_at: "2026-01-01T00:00:02+00:00", reply_to: "r1" },
        { id: "m3", workspace_id: workspace, conversation_id: conversation, role: "assistant", content: "B", created_at: "2026-01-01T00:00:03+00:00", reply_to: "r2" },
      ],
      chat_requests: [
        { id: "r1", workspace_id: workspace, usage: { model_id: "gpt-test-1", input_tokens: 3 }, tool_calls: [{ name: "plan_investigation", input: { steps: ["Check spending"] }, output: "" }, { name: "accounts_list", input: {}, output: "[]" }, { name: "transactions_search", input: {}, output: "x".repeat(50_000) }] },
        { id: "r2", workspace_id: "other", usage: { model_id: "foreign-model" }, tool_calls: [{ name: "accounts_list", input: {}, output: "secret" }] },
      ],
    };
    const fake = { from(table: string) {
      let data = [...(tables[table] ?? [])];
      const query = {
        select: () => query, is: () => query, order: () => query, limit: () => query, gte: () => query, lt: () => query, overlaps: () => query,
        eq: (key: string, value: string) => { data = data.filter(row => row[key] === value); return query; },
        in: (key: string, values: string[]) => { data = data.filter(row => values.includes(row[key] as string)); return query; },
        maybeSingle: async () => ({ data: data[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve),
      }; return query;
    } };
    const { messages } = await loadConversation(fake as never, workspace, conversation);
    const answer = messages.find(row => row.id === "m2");
    expect(answer).toMatchObject({ model: "gpt-test-1", plan: ["Check spending"], tools: [{ name: "accounts_list", state: "done", input: {}, output: "[]" }, { name: "transactions_search" }] });
    expect(answer?.tools?.[1].output).toHaveLength(2000 + "\n… (truncated)".length);
    expect(answer).not.toHaveProperty("reply_to");
    expect(messages.find(row => row.id === "m3")).not.toHaveProperty("tools");
    expect(messages.find(row => row.id === "m3")).not.toHaveProperty("model");
    expect(messages.find(row => row.id === "m1")).toMatchObject({ spoken: true });
    expect(messages.find(row => row.id === "m1")).not.toHaveProperty("context");
    expect(answer).not.toHaveProperty("spoken");
  });
});

describe("background chat runs", () => {
  it("names the conversation's recent running request and ignores stale or finished ones", async () => {
    const conversation = "00000000-0000-4000-8000-000000000001";
    const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();
    const load = (requests: Record<string, unknown>[]) => loadConversation({ from(table: string) {
      let data = table === "conversations" ? [{ id: conversation, workspace_id: workspace, title: "T", created_at: ago(600) }] : table === "chat_requests" ? [...requests] : [];
      const query = {
        select: () => query, is: () => query, limit: () => query, in: () => query, gte: () => query, lt: () => query, overlaps: () => query,
        eq: (key: string, value: string) => { data = data.filter(row => row[key as keyof typeof row] === value); return query; },
        order: () => { data.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))); return query; },
        maybeSingle: async () => ({ data: data[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data, error: null }).then(resolve),
      }; return query;
    } } as never, workspace, conversation);
    const request = (id: string, status: string, seconds: number, owner = workspace) => ({ id, workspace_id: owner, conversation_id: conversation, status, created_at: ago(seconds) });
    expect((await load([request("done", "completed", 5), request("live", "running", 20)])).running).toBe("live");
    expect((await load([request("stale", "running", 600)])).running).toBeNull();
    expect((await load([request("foreign", "running", 5, "other")])).running).toBeNull();
  });
});
