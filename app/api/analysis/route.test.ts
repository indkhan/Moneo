import { expect, it, vi } from "vitest";
import { POST } from "./route";
import { requireWorkspace } from "@/lib/auth";
import { startFinancialReview } from "@/lib/finance/start-review";
import { DEFAULT_SETTINGS } from "@/lib/settings";
vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));
vi.mock("@/lib/ai/provider", () => ({ modelForSettings: vi.fn(async () => ({})), getModel: vi.fn() }));
vi.mock("@/lib/finance/start-review", () => ({ startFinancialReview: vi.fn(async () => ({ jobId: "job", status: "queued" })) }));
it("uses the reviewed request identity and refuses disabled financial data scope", async () => {
  process.env.OPENROUTER_API_KEY = "test"; process.env.SUPABASE_SERVICE_ROLE_KEY = "test"; process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.test";
  const context = { workspace: { id: "w" }, supabase: {}, settings: DEFAULT_SETTINGS };
  vi.mocked(requireWorkspace).mockResolvedValue(context as unknown as Awaited<ReturnType<typeof requireWorkspace>>);
  const requestId = "00000000-0000-4000-8000-000000000001";
  const request = () => new Request("http://localhost/api/analysis", { method: "POST", body: JSON.stringify({ requestId }) });
  expect((await POST(request())).status).toBe(202);
  expect(startFinancialReview).toHaveBeenCalledWith(context.supabase, "w", requestId);
  vi.mocked(requireWorkspace).mockResolvedValue({ ...context, settings: { ...DEFAULT_SETTINGS, ai_data_scopes: [] } } as unknown as Awaited<ReturnType<typeof requireWorkspace>>);
  expect((await POST(request())).status).toBe(403);
});
