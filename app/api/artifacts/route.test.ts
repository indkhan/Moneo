import { beforeEach, expect, it, vi } from "vitest";
import { POST } from "./route";
import { requireWorkspace } from "@/lib/auth";
import { DEFAULT_SETTINGS } from "@/lib/settings";

type Options = { abortSignal: AbortSignal; tools: Record<string, { execute: (input: unknown) => Promise<unknown> }> };
const { generateText, after } = vi.hoisted(() => ({ generateText: vi.fn(async (options: Options) => { void options; return {}; }), after: vi.fn() }));
vi.mock("ai", () => ({ generateText, tool: (value: unknown) => value, hasToolCall: (name: string) => name, stepCountIs: (count: number) => count }));
vi.mock("next/server", async original => ({ ...await original<typeof import("next/server")>(), after }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));
vi.mock("@/lib/ai/provider", () => ({ modelForSettings: vi.fn(async () => ({ modelId: "free" })) }));

let writes: { table: string; op: "insert" | "update"; values: Record<string, unknown> }[];
beforeEach(() => {
  vi.clearAllMocks(); writes = []; process.env.OPENAI_API_KEY = "test";
  const from = (table: string) => {
    const query = {
      insert: (values: Record<string, unknown>) => { writes.push({ table, op: "insert", values }); return query; },
      update: (values: Record<string, unknown>) => { writes.push({ table, op: "update", values }); return query; },
      select: () => query, eq: () => query, order: () => query,
      single: async () => ({ data: { id: table === "artifact_builds" ? "build" : "artifact" }, error: null }),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve),
    };
    return query;
  };
  vi.mocked(requireWorkspace).mockResolvedValue({ supabase: { from }, workspace: { id: "workspace", display_currency: "EUR" }, settings: DEFAULT_SETTINGS } as unknown as Awaited<ReturnType<typeof requireWorkspace>>);
});
const page = { title: "Rent what-if", html: "<p>Rent</p>", queries: [] };
const build = () => writes.find(write => write.table === "artifact_builds" && write.op === "update")?.values;

it("finishes and saves a build after the client goes away", async () => {
  const client = new AbortController();
  client.abort();
  vi.mocked(generateText).mockImplementationOnce(async options => {
    expect(options.abortSignal.aborted).toBe(false);
    await options.tools.save_artifact.execute(page);
    return {};
  });
  const response = await POST(new Request("http://localhost/api/artifacts", { method: "POST", signal: client.signal, body: JSON.stringify({ message: "Show my rent" }) }));
  expect(await response.json()).toEqual({ id: "artifact", version: 1 });
  expect(writes.find(write => write.table === "artifact_builds" && write.op === "insert")?.values).toMatchObject({ workspace_id: "workspace", artifact_id: null, prompt: "Show my rent" });
  expect(writes.find(write => write.table === "artifact_versions")?.values).toMatchObject({ artifact_id: "artifact", version: 1, html: page.html });
  expect(build()).toMatchObject({ status: "completed", artifact_id: "artifact", version: 1 });
  expect(after).toHaveBeenCalledOnce();
});

it("records why a build failed so it is visible later", async () => {
  vi.mocked(generateText).mockRejectedValueOnce(new Error("Provider unavailable"));
  const response = await POST(new Request("http://localhost/api/artifacts", { method: "POST", body: JSON.stringify({ message: "Show my rent" }) }));
  expect(response.status).toBe(502);
  expect(build()).toMatchObject({ status: "failed", error: "Provider unavailable" });
  expect(writes.some(write => write.table === "artifacts" || write.table === "artifact_versions")).toBe(false);
});
