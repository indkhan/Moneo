import { beforeEach, expect, it, vi } from "vitest";
import { POST } from "./route";
import { requireWorkspace } from "@/lib/auth";
import { conversationWords, writeTitle } from "@/lib/ai/chat-title";

vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));
vi.mock("@/lib/ai/provider", () => ({ modelForSettings: vi.fn() }));
vi.mock("@/lib/ai/chat-title", () => ({ conversationWords: vi.fn(), writeTitle: vi.fn() }));

const id = "00000000-0000-4000-8000-000000000001";
const route = (value = id) => ({ params: Promise.resolve({ id: value }) });
const request = new Request("http://localhost", { method: "POST" });
const filters: unknown[][] = [];
let updated: unknown, row: unknown;

beforeEach(() => {
  vi.clearAllMocks(); filters.length = 0; updated = undefined; row = { id };
  const query = { update: (values: unknown) => { updated = values; return query; }, eq: (...args: unknown[]) => { filters.push(args); return query; }, is: (...args: unknown[]) => { filters.push(args); return query; }, select: () => query, maybeSingle: async () => ({ data: row, error: null }) };
  vi.mocked(requireWorkspace).mockResolvedValue({ workspace: { id: "owned" }, settings: {}, supabase: { from: () => query } } as never);
  vi.mocked(conversationWords).mockResolvedValue("how much at Netto");
  vi.mocked(writeTitle).mockResolvedValue({ title: "Netto spending", vague: false });
});

it("writes a new title over a rename, in the signed-in workspace only", async () => {
  const response = await POST(request, route());
  expect(await response.json()).toEqual({ title: "Netto spending" });
  expect(updated).toEqual({ title: "Netto spending", title_settled: true });
  expect(filters).toEqual([["workspace_id", "owned"], ["id", id], ["deleted_at", null]]);
});

it("keeps the title and says why when it can't write one", async () => {
  vi.mocked(writeTitle).mockResolvedValue(null);
  expect((await POST(request, route())).status).toBe(502);
  vi.mocked(conversationWords).mockResolvedValue("");
  expect((await POST(request, route())).status).toBe(400);
  expect(updated).toBeUndefined();
});

it("refuses a bad id, a stranger and a chat that is gone", async () => {
  expect((await POST(request, route("nope"))).status).toBe(404);
  row = null;
  expect((await POST(request, route())).status).toBe(404);
  vi.mocked(requireWorkspace).mockRejectedValue(new Error("no"));
  expect((await POST(request, route())).status).toBe(401);
});
