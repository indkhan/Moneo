import { beforeEach, expect, it, vi } from "vitest";
import { GET } from "./route";
import { conversationWords, saveTitle, writeTitle } from "@/lib/ai/chat-title";

const { db, updates } = vi.hoisted(() => {
  const updates: unknown[] = [];
  const db = { rows: [] as unknown[], from: () => {
    const query = { select: () => query, eq: () => query, is: () => query, lt: () => query, order: () => query, limit: async () => ({ data: db.rows, error: null }),
      update: (values: unknown) => { updates.push(values); return query; } };
    return query;
  } };
  return { db, updates };
});
vi.mock("@supabase/supabase-js", () => ({ createClient: () => db }));
vi.mock("@/lib/ai/configured", () => ({ aiConfigured: vi.fn(async () => true) }));
vi.mock("@/lib/ai/provider", () => ({ modelForSettings: vi.fn() }));
vi.mock("@/lib/ai/chat-title", () => ({ conversationWords: vi.fn(), saveTitle: vi.fn(), writeTitle: vi.fn() }));

const authorized = new Request("http://localhost/api/cron/chat-titles", { headers: { authorization: "Bearer secret" } });

beforeEach(() => {
  vi.clearAllMocks(); updates.length = 0;
  vi.stubEnv("CRON_SECRET", "secret"); vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://db"); vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "key");
  db.rows = [{ id: "a", workspace_id: "w" }, { id: "b", workspace_id: "w" }];
  vi.mocked(conversationWords).mockResolvedValue("how much at Netto");
});

it("needs the cron secret", async () => {
  expect((await GET(new Request("http://localhost/api/cron/chat-titles"))).status).toBe(401);
  expect(conversationWords).not.toHaveBeenCalled();
});

it("takes the written title even when the words are vague, so a chat is only asked once", async () => {
  vi.mocked(writeTitle).mockResolvedValue({ title: "General help", vague: true });
  expect(await (await GET(authorized)).json()).toEqual({ titled: 2 });
  expect(saveTitle).toHaveBeenCalledWith(db, "w", "a", "General help");
});

it("stops when the AI is down, leaving the rest for the next run", async () => {
  vi.mocked(writeTitle).mockResolvedValue(null);
  expect(await (await GET(authorized)).json()).toEqual({ titled: 0 });
  expect(writeTitle).toHaveBeenCalledTimes(1);
  expect(saveTitle).not.toHaveBeenCalled();
});

it("settles a chat with nothing to name without asking the model", async () => {
  vi.mocked(conversationWords).mockResolvedValue("");
  await GET(authorized);
  expect(writeTitle).not.toHaveBeenCalled();
  expect(updates).toEqual([{ title_settled: true }, { title_settled: true }]);
});
