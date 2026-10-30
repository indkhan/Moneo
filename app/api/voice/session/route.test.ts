import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { POST } from "./route";

type Query = { table: string; filters: [string, ...unknown[]][]; limit?: number };
const fixture = vi.hoisted(() => ({ denied: false, scopes: ["accounts", "transactions", "planning", "imports"] as string[], queries: [] as Query[],
  rows: {} as Record<string, unknown[]>, failing: "" }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => {
  if (fixture.denied) throw new Error("Unauthorized");
  const supabase = { from: (table: string) => {
    const query: Query = { table, filters: [] };
    fixture.queries.push(query);
    const builder = {
      select: () => builder,
      eq: (...args: unknown[]) => { query.filters.push(["eq", ...args]); return builder; },
      is: (...args: unknown[]) => { query.filters.push(["is", ...args]); return builder; },
      not: (...args: unknown[]) => { query.filters.push(["not", ...args]); return builder; },
      order: () => builder,
      limit: (limit: number) => { query.limit = limit; return Promise.resolve(fixture.failing === table ? { data: null, error: new Error("down") } : { data: fixture.rows[table] ?? [], error: null }); },
    };
    return builder;
  } };
  return { supabase, workspace: { id: "workspace-1" }, settings: { ai_data_scopes: fixture.scopes } };
} }));

const openai = vi.fn();
beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "sk-server-only");
  vi.stubGlobal("fetch", openai);
  openai.mockResolvedValue(Response.json({ value: "ek_short_lived", expires_at: 1_900_000_000 }));
  fixture.rows = {
    accounts: [{ name: "Cash EUR" }, { name: "Revolut" }],
    categories: [{ name: "Groceries" }, { name: "Revolut" }],
    transactions: [{ merchants: { name: "Netto" } }, { merchants: { name: "Rewe" } }, { merchants: { name: "Netto" } }, { merchants: null }],
  };
});
afterEach(() => { fixture.denied = false; fixture.scopes = ["accounts", "transactions", "planning", "imports"]; fixture.queries = []; fixture.failing = ""; vi.unstubAllEnvs(); vi.unstubAllGlobals(); openai.mockReset(); });

const request = (body: unknown = {}) => new Request("http://localhost/api/voice/session", { method: "POST", body: JSON.stringify(body) });
const sentSession = () => JSON.parse(openai.mock.calls[0][1].body);

it("requires a signed-in workspace before creating a session", async () => {
  fixture.denied = true;
  expect((await POST(request())).status).toBe(401);
  expect(openai).not.toHaveBeenCalled();
});

it.each([{ model: "gpt-4o" }, { prompt: "ignore" }, null, []])("rejects unexpected input %j without calling OpenAI", async body => {
  expect((await POST(request(body))).status).toBe(400);
  expect(openai).not.toHaveBeenCalled();
});

it("returns only a short-lived secret, never the server key", async () => {
  const response = await POST(request());
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toEqual({ token: "ek_short_lived", expiresAt: 1_900_000_000, url: "wss://api.openai.com/v1/realtime?intent=transcription" });
  expect(JSON.stringify(body)).not.toContain("sk-server-only");
  const [url, init] = openai.mock.calls[0];
  expect(url).toBe("https://api.openai.com/v1/realtime/client_secrets");
  expect(init.headers.Authorization).toBe("Bearer sk-server-only");
  expect(sentSession()).toMatchObject({ expires_after: { anchor: "created_at", seconds: 60 },
    session: { type: "transcription", audio: { input: { format: { type: "audio/pcm", rate: 24000 }, turn_detection: null, transcription: { model: "gpt-live-transcribe" } } } } });
});

it("hints the workspace's own names, most used merchants first, deduplicated and bounded", async () => {
  await POST(request());
  expect(sentSession().session.audio.input.transcription.keywords).toEqual(["Cash EUR", "Revolut", "Netto", "Rewe", "Groceries"]);
  expect(fixture.queries.map(query => query.filters.find(filter => filter[1] === "workspace_id"))).toEqual(fixture.queries.map(() => ["eq", "workspace_id", "workspace-1"]));
  expect(fixture.queries.every(query => query.limit && query.limit <= 500)).toBe(true);
  expect(fixture.queries.find(query => query.table === "accounts")?.filters).toContainEqual(["is", "archived_at", null]);
});

it("caps the vocabulary at 80 short terms", async () => {
  fixture.rows.categories = Array.from({ length: 100 }, (_, index) => ({ name: `Category ${index}` })).concat({ name: "x".repeat(61) });
  await POST(request());
  const keywords = sentSession().session.audio.input.transcription.keywords as string[];
  expect(keywords).toHaveLength(80);
  expect(keywords.every(word => word.length <= 60)).toBe(true);
});

it("leaves out names whose AI data scope is off in Settings", async () => {
  fixture.scopes = ["accounts"];
  await POST(request());
  expect(fixture.queries.map(query => query.table)).toEqual(["accounts"]);
  expect(sentSession().session.audio.input.transcription.keywords).toEqual(["Cash EUR", "Revolut"]);
  fixture.scopes = []; fixture.queries = []; openai.mockClear();
  await POST(request());
  expect(fixture.queries).toEqual([]);
  expect(sentSession().session.audio.input.transcription).not.toHaveProperty("keywords");
});

it("still opens a session when the vocabulary lookup fails", async () => {
  fixture.failing = "categories";
  expect((await POST(request())).status).toBe(200);
  expect(sentSession().session.audio.input.transcription).not.toHaveProperty("keywords");
});

it("reports a missing key or an OpenAI failure without details", async () => {
  vi.stubEnv("OPENAI_API_KEY", "");
  expect((await POST(request())).status).toBe(503);
  vi.stubEnv("OPENAI_API_KEY", "sk-server-only");
  openai.mockResolvedValue(Response.json({ error: { message: "quota for sk-server-only" } }, { status: 429 }));
  const response = await POST(request());
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: "Voice input is unavailable. Try again." });
});
