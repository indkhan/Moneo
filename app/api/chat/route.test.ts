import { beforeEach, expect, it, vi } from "vitest";
import { generateText } from "ai";
import { POST } from "./route";
import { requireWorkspace } from "@/lib/auth";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { startFinancialReview } from "@/lib/finance/start-review";
vi.mock("ai", () => ({ generateText: vi.fn(async () => ({ text: "Evidence reviewed", totalUsage: {} })), tool: (value: unknown) => value, stepCountIs: (value: number) => value }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));
vi.mock("@/lib/ai/provider", () => ({ SYSTEM_PROMPT: "", modelForSettings: vi.fn(async () => ({ modelId: "free" })) }));
vi.mock("@/lib/finance/start-review", () => ({ startFinancialReview: vi.fn(async () => ({ jobId: "job", status: "queued" })) }));
vi.mock("@/lib/finance/review-loader", () => ({ loadFinancialReviewEvidence: vi.fn(async () => ({ source: "exact evidence" })) }));
vi.mock("@/lib/finance/edit-preview", async original => ({ ...await original<typeof import("@/lib/finance/edit-preview")>(), loadCategoryPreview: vi.fn(async () => ({ href: "/ai/actions/preview?ids=selected&category=owned", warning: "Preview only" })) }));
beforeEach(() => {
  vi.clearAllMocks(); process.env.OPENROUTER_API_KEY = "test"; process.env.SUPABASE_SERVICE_ROLE_KEY = "test"; process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.test";
  const query = { select: () => query, eq: () => query, order: () => query, limit: async () => ({ data: [], error: null }), maybeSingle: async () => ({ data: { id: "conversation" }, error: null }) };
  const rpc = vi.fn(async (name: string) => ({ error: null, data: name === "start_chat_request" ? { started: true } : "completed" }));
  vi.mocked(requireWorkspace).mockResolvedValue({ supabase: { from: () => query, rpc }, workspace: { id: "workspace", display_currency: "EUR" }, settings: DEFAULT_SETTINGS } as unknown as Awaited<ReturnType<typeof requireWorkspace>>);
});
const requestId = "00000000-0000-4000-8000-000000000001";
const request = (message: string) => new Request("http://localhost/api/chat", { method: "POST", body: JSON.stringify({ conversationId: "00000000-0000-4000-8000-000000000002", requestId, message }) });
it("offers scoped investigation and exact-intent review start within four model steps", async () => {
  expect((await POST(request("Start a deep financial review"))).status).toBe(200);
  const options = vi.mocked(generateText).mock.calls[0][0];
  expect(options.stopWhen).toBe(4);
  const tools = options.tools as unknown as Record<string, { execute: () => Promise<unknown> }>;
  expect(await tools.reviews_investigate.execute()).toEqual({ source: "exact evidence" });
  expect(await tools.reviews_start.execute()).toMatchObject({ jobId: "job", status: "queued", href: "/ai" });
  expect(startFinancialReview).toHaveBeenCalledWith(expect.anything(), "workspace", requestId, requestId);
});
it("questions do not expose the review-start tool", async () => {
  await POST(request("Should I start a deep financial review?"));
  expect(vi.mocked(generateText).mock.calls[0][0].tools).not.toHaveProperty("reviews_start");
});
it("creates a trusted chart only for an explicit artifact request and reuses it within the request", async () => {
  await POST(request("Can you create a monthly spending chart?"));
  const context = await requireWorkspace();
  vi.mocked(context.supabase.rpc).mockResolvedValueOnce({ data: { id: requestId }, error: null } as never);
  const tools = vi.mocked(generateText).mock.calls[0][0].tools as unknown as Record<string, { execute: (input: unknown) => Promise<unknown> }>;
  const input = { kind: "spending_explorer", name: "Monthly spending" };
  expect(await tools.artifacts_create.execute(input)).toMatchObject({ href: `/ai/library/${requestId}` });
  await tools.artifacts_create.execute(input);
  expect(context.supabase.rpc).toHaveBeenCalledWith("create_trusted_artifact", { p_kind: input.kind, p_name: input.name });
  expect(vi.mocked(context.supabase.rpc).mock.calls.filter(call => call[0] === "create_trusted_artifact")).toHaveLength(1);
});
it("artifact questions do not expose a creation tool", async () => {
  await POST(request("How do I create a spending chart?"));
  expect(vi.mocked(generateText).mock.calls[0][0].tools).not.toHaveProperty("artifacts_create");
});
it("broad category requests offer only an owned-selection preview, never an immediate write", async () => {
  await POST(request("Categorize all grocery transactions as Food"));
  const tools = vi.mocked(generateText).mock.calls[0][0].tools as unknown as Record<string, { execute: (input: unknown) => Promise<unknown> }>;
  expect(tools).not.toHaveProperty("transactions_setCategory");
  expect(await tools.transactions_previewCategory.execute({ transactionIds: [requestId], categoryId: requestId })).toMatchObject({ warning: "Preview only", href: expect.stringContaining("/ai/actions/preview") });
});
