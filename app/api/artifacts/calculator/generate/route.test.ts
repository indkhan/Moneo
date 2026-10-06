import { afterEach, expect, it, vi } from "vitest";
import { POST } from "./route";
const fixture = vi.hoisted(() => ({ generateText: vi.fn() }));
vi.mock("ai", async original => ({ ...await original<typeof import("ai")>(), generateText: fixture.generateText, generateObject: vi.fn(() => { throw new Error("Provider does not support json_schema"); }) }));
vi.mock("@/lib/ai/provider", () => ({ modelForSettings: async () => ({ modelId: "verified-free-model" }) }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({ workspace: { id: "w" }, settings: {}, supabase: { from: (table: string) => {
  const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: table === "artifacts" ? { id: "00000000-0000-4000-8000-000000000001", kind: "custom_comparison", permissions: [], active_version_id: "v" } : { source: "(input) => ({summary:'Previous'})", manifest: {} }, error: null }) };
  return query;
} } }) }));
vi.mock("@/lib/artifacts/validate", () => ({ validateGeneratedCandidate: vi.fn(async () => ({ ok: true, warnings: [] })) }));
vi.mock("@/lib/artifacts/generation", () => ({ runArtifactGeneration: async (_db: unknown, _request: unknown, _input: unknown, generate: () => Promise<{ result: unknown }>) => {
  try { return Response.json((await generate()).result); } catch (error) { return Response.json({ error: String(error) }, { status: 502 }); }
} }));
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
it("validates a real JSON text draft without requiring provider json_schema support", async () => {
  vi.stubEnv("OPENROUTER_API_KEY", "test");
  fixture.generateText.mockResolvedValue({ totalUsage: {}, text: JSON.stringify({ source: "(input) => ({summary:'Exact'})", manifest: { kind: "custom_comparison", runtime: "quickjs-calculator-v1", sdk: [], params: {}, renderer: "trusted" }, rationale: "Reviewed comparison" }) });
  const response = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ artifactId: "00000000-0000-4000-8000-000000000001", description: "Compare exact amounts" }) }));
  expect(response.status).toBe(200);
  expect((await response.json()).validation).toEqual({ ok: true, warnings: [] });
  expect(fixture.generateText).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: 4000, abortSignal: expect.any(AbortSignal), output: expect.objectContaining({ name: "json" }) }));
  expect(fixture.generateText.mock.calls[0][0].prompt).toContain("summary must be a string");
  const prompt = fixture.generateText.mock.calls[0][0].prompt;
  expect(prompt).toContain("withTripAvailableMinor"); expect(prompt).toContain("spendingLimitingDate");
  expect(prompt).toContain("Never subtract cost from baselineAvailableMinor");
  expect(prompt).toContain("explicit paired dated funding");
});
it("retains the source version used to generate a draft, including Activity recovery", async () => {
  vi.stubEnv("OPENROUTER_API_KEY", "test");
  fixture.generateText.mockResolvedValue({ totalUsage: {}, text: JSON.stringify({ source: "input => ({summary:'Draft'})", manifest: { kind: "custom_comparison", runtime: "quickjs-calculator-v1", sdk: [], params: {}, renderer: "trusted" }, rationale: "Synthetic draft" }) });
  const response = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ artifactId: "00000000-0000-4000-8000-000000000001", description: "Synthetic draft" }) }));
  expect((await response.json()).baseVersionId).toBe("v");
});
it("rejects malformed or out-of-contract JSON rather than fabricating a draft", async () => {
  vi.stubEnv("OPENROUTER_API_KEY", "test"); fixture.generateText.mockResolvedValue({ text: "Here is some guessed code" });
  const response = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ artifactId: "00000000-0000-4000-8000-000000000001", description: "Compare exact amounts" }) }));
  expect(response.status).toBe(502);
});
