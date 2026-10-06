import { describe, expect, it } from "vitest";
import { loadConversationHistory } from "./conversation-history";

const workspace = "owned";
const rows = Array.from({ length: 1000 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, workspace_id: workspace, conversation_id: "00000000-0000-4000-8000-000000000000", title: `Thread ${i}`, content: `Message ${i}`, created_at: "2026-01-01T00:00:00+00:00" }));
function client(fail: boolean | "selected" | "messages" = false) {
  return { from(table: string) {
    let data = table === "messages" ? [...rows] : rows.slice(0, 100);
    const query = {
      select: () => query,
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
  it("directly loads the 100th thread and newest of 1000 tied messages", async () => {
    const result = await loadConversationHistory(client() as never, workspace, rows[0].id);
    expect(result.selected?.id).toBe(rows[0].id);
    expect(result.messages.at(-1)?.content).toBe("Message 999");
    expect(result.messages[0].content).toBe("Message 900");
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
      expect(next.messages).toHaveLength(100);
      const newest = await loadConversationHistory(client() as never, workspace, "00000000-0000-4000-8000-000000000000");
      expect(newest.messages.at(-1)?.id).toBe(arrival.id);
    } finally { rows.shift(); }
  });
  it("explicit New does not select a saved thread and malformed cursors fail", async () => {
    expect((await loadConversationHistory(client() as never, workspace, "new")).selected).toBeNull();
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
