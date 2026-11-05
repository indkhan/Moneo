import { beforeEach, expect, it, vi } from "vitest";
import { artifactTools } from "./artifact-agent";

const model = vi.hoisted(() => ({ generate: vi.fn() }));
vi.mock("ai", async original => ({ ...await original<typeof import("ai")>(), generateText: model.generate }));
vi.mock("./provider", () => ({ modelForSettings: async () => ({ modelId: "synthetic" }) }));

const insert = vi.fn<(row: unknown) => Promise<{ error: null }>>().mockResolvedValue({ error: null });
const query = { select: () => query, eq: () => query, order: () => query, limit: () => query,
  maybeSingle: async () => ({ data: null, error: null }), insert, update: () => query, error: null };
const context = { supabase: { from: () => query }, workspace: { id: "workspace", locale: "en" }, settings: { timezone: "UTC" } } as never;
const run = { context, artifactId: "artifact", signal: new AbortController().signal, ensureActive: async () => {} };
const input = { title: "Balance", brief: "Show my balance", queries: [], params: [] };

beforeEach(() => { insert.mockClear(); model.generate.mockReset(); });

it("saves only checked Page code, without a browser-executable HTML version", async () => {
  model.generate.mockResolvedValue({ text: "export default function Page() { return <p>Checked Page</p>; }" });
  const result = await artifactTools(run).write_page.execute!(input, { toolCallId: "page", messages: [], context: {} });
  expect(result).toMatchObject({ saved: true, pageVersion: 1 });
  expect(insert).toHaveBeenCalledOnce();
  const saved = insert.mock.calls[0][0];
  expect(saved).toMatchObject({ source: expect.stringContaining("export default"), compiled: expect.any(String), params: [] });
  expect(saved).not.toHaveProperty("html");
});

it("refuses an old HTML response instead of saving it as executable Page content", async () => {
  model.generate.mockResolvedValue({ text: '<html><script>location.replace("https://receiver.invalid")</script></html>' });
  const result = await artifactTools(run).write_page.execute!(input, { toolCallId: "page", messages: [], context: {} });
  expect(result).toMatchObject({ saved: false });
  expect(insert).not.toHaveBeenCalled();
});
