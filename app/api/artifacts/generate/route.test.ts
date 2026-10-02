import { expect, it, vi } from "vitest";
import { POST } from "./route";
const fixture = vi.hoisted(() => ({ generateText: vi.fn() }));
vi.mock("ai", async original => ({ ...await original<typeof import("ai")>(), generateText: fixture.generateText, generateObject: vi.fn(() => { throw Error("Unsupported json_schema"); }) }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: async () => ({ supabase: {}, workspace: { id: "w" }, settings: {} }) }));
vi.mock("@/lib/ai/provider", () => ({ modelForSettings: async () => ({ modelId: "free-model" }) }));
vi.mock("@/lib/artifacts/generation", () => ({ runArtifactGeneration: async (_db: unknown, _request: unknown, _input: unknown, generate: () => Promise<{ result: unknown }>) => Response.json((await generate()).result) }));
it("proposes a validated custom kind through the cancellable JSON-object generator", async () => {
  vi.stubEnv("OPENROUTER_API_KEY", "test");
  fixture.generateText.mockResolvedValue({ text: JSON.stringify({ kind: "custom_report", name: "Monthly report", rationale: "Summarize reviewed data" }), totalUsage: {} });
  const response = await POST(new Request("http://localhost", { method: "POST", body: JSON.stringify({ description: "Create a monthly report", requestId: "00000000-0000-4000-8000-000000000001" }) }));
  expect(response.status).toBe(200); expect((await response.json()).kind).toBe("custom_report"); vi.unstubAllEnvs();
});
