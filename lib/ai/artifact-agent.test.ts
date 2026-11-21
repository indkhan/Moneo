import { beforeEach, expect, it, vi } from "vitest";
import { generateText } from "ai";
import { artifactTools } from "./artifact-agent";

vi.mock("ai", async importOriginal => ({ ...await importOriginal<object>(), generateText: vi.fn() }));
vi.mock("@/lib/ai/provider", () => ({ modelForSettings: async () => ({ modelId: "test-model" }) }));
const queries = vi.hoisted(() => ({ run: async (): Promise<Record<string, unknown>> => ({ recurring: { schedules: [] } }) }));
vi.mock("@/lib/ai/artifact-data", async importOriginal => ({ ...await importOriginal<object>(), runArtifactQueries: () => queries.run() }));
const preview = vi.hoisted(() => ({ seen: null as null | { label: string; png: Uint8Array; problems: string[] }[] }));
vi.mock("@/lib/ai/artifact-preview", () => ({ lookAt: async () => preview.seen }));

const BROKEN = "<html><body><script>const x = list.filter(s => (s.a || (s.b)) : [];</script></body></html>";
const FIXED = "<html><body><script>const x = [];</script></body></html>";

function run() {
  const inserts: Record<string, unknown>[] = [];
  const query: Record<string, unknown> = {};
  for (const name of ["select", "eq", "order", "limit", "update"]) query[name] = () => query;
  query.maybeSingle = async () => ({ data: { version: 1, html: "<p>v1</p>" }, error: null });
  query.insert = async (row: Record<string, unknown>) => { inserts.push(row); return { error: null }; };
  query.then = (resolve: (value: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve);
  const context = { supabase: { from: () => query }, workspace: { id: "w", locale: "en-GB" }, settings: { timezone: "Europe/Berlin" } };
  const tools = artifactTools({ context, artifactId: "a", signal: new AbortController().signal, ensureActive: async () => {}, scalable: null, ownerWords: [], session: [] } as never);
  const write = (input: object) => (tools.write_page.execute as unknown as (input: object, options: object) => Promise<Record<string, unknown>>)(input, { toolCallId: "t", messages: [] });
  return { inserts, write };
}
const input = { title: "Subscription radar", brief: "Outgoing items only", queries: [{ name: "recurring", source: "recurring", input: {} }] };

beforeEach(() => { vi.mocked(generateText).mockReset(); preview.seen = null; });

it("sends a page whose script doesn't parse back to the designer and saves the fixed one", async () => {
  vi.mocked(generateText).mockResolvedValueOnce({ text: BROKEN } as never).mockResolvedValueOnce({ text: FIXED } as never);
  const { inserts, write } = run();
  expect(await write(input)).toMatchObject({ saved: true, pageVersion: 2 });
  expect(inserts).toEqual([expect.objectContaining({ html: FIXED, version: 2 })]);
  expect(String(vi.mocked(generateText).mock.calls[1][0].prompt)).toContain("does not parse");
});

it("keeps the current version when the designer can't produce a page that parses", async () => {
  vi.mocked(generateText).mockResolvedValue({ text: BROKEN } as never);
  const { inserts, write } = run();
  const result = await write(input);
  expect(result).toMatchObject({ saved: false });
  expect(String((result.errors as string[])[0])).toContain("current version was kept");
  expect(inserts).toEqual([]);
  expect(generateText).toHaveBeenCalledTimes(3);
});

it("shows the designer every query's shape even when an earlier one is large", async () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({ merchant: `Merchant ${index}`, amount_minor: "-1250", note: "x".repeat(200) }));
  queries.run = async () => ({ history: { groups: rows }, balances: { accounts: [{ name: "Giro", currency: "EUR", balance_minor: "100346" }] } });
  vi.mocked(generateText).mockResolvedValue({ text: FIXED } as never);
  await run().write({ ...input, queries: [{ name: "history", source: "transactions", input: {} }, { name: "balances", source: "balances", input: {} }] });
  const prompt = String(vi.mocked(generateText).mock.calls[0][0].prompt);
  expect(prompt).toContain("balance_minor");
  expect(prompt).toContain("Merchant 0");
  expect(prompt).toMatch(/97 more/);
});

it("shows the designer how its page renders and saves the version it fixes, or keeps it when it says OK", async () => {
  const LOOKED = "<html><body><p>roomier</p></body></html>";
  preview.seen = [{ label: "Phone, light", png: new Uint8Array([137, 80]), problems: ["The page scrolls sideways at 390px wide"] }];
  vi.mocked(generateText).mockResolvedValueOnce({ text: FIXED } as never).mockResolvedValueOnce({ text: LOOKED } as never).mockResolvedValueOnce({ text: "OK" } as never);
  const first = run();
  expect(await first.write(input)).toMatchObject({ saved: true });
  expect(first.inserts).toEqual([expect.objectContaining({ html: LOOKED })]);
  const look = vi.mocked(generateText).mock.calls[1][0] as unknown as { messages: { role: string; content: unknown }[] };
  expect(JSON.stringify(look.messages.at(-1)?.content)).toContain("scrolls sideways");
  expect(look.messages.at(-1)?.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "file", mediaType: "image/png" })]));

  vi.mocked(generateText).mockReset().mockResolvedValueOnce({ text: FIXED } as never).mockResolvedValueOnce({ text: "OK" } as never);
  const second = run();
  await second.write(input);
  expect(second.inserts).toEqual([expect.objectContaining({ html: FIXED })]);
});
