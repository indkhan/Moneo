import { beforeEach, expect, it, vi } from "vitest";
import { generateText } from "ai";
import { POST } from "./route";
import { requireWorkspace } from "@/lib/auth";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { loadCategoryPreview } from "@/lib/finance/edit-preview";
import { loadFinancialReviewEvidence } from "@/lib/finance/review-loader";
import { listAccounts, getBalances, cashflow, searchTransactions, listGoals, evaluateForecast } from "@/lib/finance/tools";
import { startFinancialReview } from "@/lib/finance/start-review";
vi.mock("ai", () => ({ generateText: vi.fn(async () => ({ text: "Evidence reviewed", totalUsage: {} })), tool: (value: unknown) => value, stepCountIs: (value: number) => value }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));
vi.mock("@/lib/ai/provider", () => ({ SYSTEM_PROMPT: "", modelForSettings: vi.fn(async () => ({ modelId: "free" })) }));
vi.mock("@/lib/finance/start-review", () => ({ startFinancialReview: vi.fn(async () => ({ jobId: "job", status: "queued" })) }));
vi.mock("@/lib/finance/review-loader", () => ({ loadFinancialReviewEvidence: vi.fn(async () => ({ source: "exact evidence" })) }));
vi.mock("@/lib/finance/edit-preview", async original => ({ ...await original<typeof import("@/lib/finance/edit-preview")>(), loadCategoryPreview: vi.fn(async () => ({ href: "/ai/actions/preview?ids=selected&category=owned", warning: "Preview only" })) }));
vi.mock("@/lib/finance/tools", () => Object.fromEntries(["listAccounts", "getBalances", "cashflow", "searchTransactions", "listGoals", "evaluateForecast"].map(name => [name, vi.fn(async () => ({ synthetic: name }))])));
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
  const results = await Promise.all([tools.artifacts_create.execute(input), tools.artifacts_create.execute(input)]);
  expect(results).toEqual([{ id: requestId, href: `/ai/library/${requestId}` }, { id: requestId, href: `/ai/library/${requestId}` }]);
  expect(context.supabase.rpc).toHaveBeenCalledWith("create_trusted_artifact", { p_kind: input.kind, p_name: input.name });
  expect(vi.mocked(context.supabase.rpc).mock.calls.filter(call => call[0] === "create_trusted_artifact")).toHaveLength(1);
});
it("artifact questions do not expose a creation tool", async () => {
  await POST(request("How do I create a spending chart?"));
  expect(vi.mocked(generateText).mock.calls[0][0].tools).not.toHaveProperty("artifacts_create");
});
it("offers import status separately from financial balance freshness and respects import scope", async () => {
  await POST(request("Have my imports completed?"));
  expect(vi.mocked(generateText).mock.calls[0][0].tools).toHaveProperty("imports_status");
  const context = await requireWorkspace();
  vi.mocked(requireWorkspace).mockResolvedValue({ ...context, settings: { ...DEFAULT_SETTINGS, ai_data_scopes: ["accounts", "transactions", "planning"] } });
  await POST(request("Have my imports completed?"));
  expect(vi.mocked(generateText).mock.calls[1][0].tools).not.toHaveProperty("imports_status");
});
it("broad category requests offer only an owned-selection preview, never an immediate write", async () => {
  await POST(request("Categorize all grocery transactions as Food"));
  const tools = vi.mocked(generateText).mock.calls[0][0].tools as unknown as Record<string, { execute: (input: unknown) => Promise<unknown> }>;
  expect(tools).not.toHaveProperty("transactions_setCategory");
  expect(await tools.transactions_previewCategory.execute({ transactionIds: [requestId], categoryId: requestId })).toMatchObject({ warning: "Preview only", href: expect.stringContaining("/ai/actions/preview") });
});

it("returns only completed tool names from actual model steps, without leaking tool inputs or results", async () => {
  vi.mocked(generateText).mockResolvedValueOnce({ text: "Done", totalUsage: {}, steps: [
    { toolResults: [{ toolName: "transactions_search", output: { private: "record" } }, { toolName: "artifacts_create" }] },
    { toolResults: [undefined, { toolName: "transactions_search" }] },
  ] } as never);
  const result = await (await POST(request("Create a spending chart"))).json();
  expect(result.toolsUsed).toEqual(["transactions_search", "artifacts_create"]);
  expect(JSON.stringify(result)).not.toContain("private");
});

const scopeTools = [
  ["accounts_list", "accounts"], ["accounts_getBalances", "accounts"],
  ["analytics_cashflow", "transactions"], ["transactions_search", "transactions"],
  ["goals_list", "planning"], ["forecast_evaluate", "planning"],
  ["forecast_evaluate", "accounts"], ["forecast_evaluate", "transactions"],
  ["imports_status", "imports"], ["transactions_previewCategory", "transactions"],
  ["reviews_investigate", "accounts"], ["reviews_investigate", "transactions"],
  ["reviews_start", "accounts"], ["reviews_start", "transactions"],
] as const;

it.each(scopeTools)("denies newly revoked %s evidence governed by %s", async (name, scope) => {
  await POST(request("Start a deep financial review"));
  const tools = vi.mocked(generateText).mock.calls[0][0].tools as unknown as Record<string, { execute: (input: unknown) => Promise<unknown> }>;
  const current = await requireWorkspace();
  vi.mocked(requireWorkspace).mockResolvedValue({ ...current, settings: { ...DEFAULT_SETTINGS, ai_data_scopes: DEFAULT_SETTINGS.ai_data_scopes.filter(value => value !== scope) } });
  await expect(tools[name].execute({ query: "synthetic", from: "2026-10-01", to: "2026-10-02", currencyCode: "EUR", horizonDays: 30, transactionIds: [requestId], categoryId: requestId })).rejects.toThrow(/disabled|permission/i);
});

const readTools = [
  ["accounts_list", "accounts", listAccounts], ["accounts_getBalances", "accounts", getBalances],
  ["analytics_cashflow", "transactions", cashflow], ["transactions_search", "transactions", searchTransactions],
  ["goals_list", "planning", listGoals], ["forecast_evaluate", "planning", evaluateForecast],
  ["forecast_evaluate", "accounts", evaluateForecast], ["forecast_evaluate", "transactions", evaluateForecast],
  ["reviews_investigate", "accounts", loadFinancialReviewEvidence], ["reviews_investigate", "transactions", loadFinancialReviewEvidence],
  ["reviews_investigate", "planning", loadFinancialReviewEvidence], ["transactions_previewCategory", "transactions", loadCategoryPreview],
  ["reviews_start", "accounts", startFinancialReview], ["reviews_start", "transactions", startFinancialReview],
] as const;
it.each(readTools)("withholds %s when %s is revoked during its paused read", async (name, scope, read) => {
  const current = await requireWorkspace();
  let release!: (value: never) => void;
  let reading!: () => void;
  const started = new Promise<void>(resolve => { reading = resolve; });
  vi.mocked(read).mockImplementationOnce(async () => { reading(); return new Promise(resolve => { release = resolve; }); });
  let received: unknown;
  vi.mocked(generateText).mockImplementationOnce(async options => {
    const tools = options.tools as unknown as Record<string, { execute: (input: unknown) => Promise<unknown> }>;
    const result = tools[name].execute({ query: "synthetic", from: "2026-10-01", to: "2026-10-02", currencyCode: "EUR", horizonDays: 30, transactionIds: [requestId], categoryId: requestId });
    await started;
    vi.mocked(requireWorkspace).mockResolvedValue({ ...current, settings: { ...DEFAULT_SETTINGS, ai_data_scopes: DEFAULT_SETTINGS.ai_data_scopes.filter(value => value !== scope) } });
    release({ synthetic: "withheld evidence" } as never);
    await expect(result).rejects.toThrow(/disabled|permission/i);
    // The provider mock receives only resolved tool outputs.
    received = await result.catch(() => undefined);
    return { text: "Permission unavailable", totalUsage: {} } as never;
  });
  expect((await POST(request("Start a deep financial review"))).status).toBe(200);
  expect(received).toBeUndefined();
});

it("allows unrelated tools and deliberately restored permissions in an existing request", async () => {
  await POST(request("Read my finances"));
  const current = await requireWorkspace();
  const tools = vi.mocked(generateText).mock.calls[0][0].tools as unknown as Record<string, { execute: (input?: unknown) => Promise<unknown> }>;
  vi.mocked(requireWorkspace).mockResolvedValue({ ...current, settings: { ...DEFAULT_SETTINGS, ai_data_scopes: ["planning"] } });
  await expect(tools.accounts_list.execute()).rejects.toThrow(/disabled/);
  expect(await tools.goals_list.execute()).toEqual({ synthetic: "listGoals" });
  vi.mocked(requireWorkspace).mockResolvedValue(current);
  expect(await tools.accounts_list.execute()).toEqual({ synthetic: "listAccounts" });
});

it("withholds import status revoked during a paused database read", async () => {
  await POST(request("Have imports completed?"));
  const current = await requireWorkspace();
  const tools = vi.mocked(generateText).mock.calls[0][0].tools as unknown as Record<string, { execute: () => Promise<unknown> }>;
  let release!: (value: unknown) => void;
  let reading!: () => void;
  const started = new Promise<void>(resolve => { reading = resolve; });
  const query = { select: () => query, eq: () => query, order: () => query, limit: async () => { reading(); return new Promise(resolve => { release = resolve; }); } };
  vi.mocked(requireWorkspace).mockResolvedValue({ ...current, supabase: { ...current.supabase, from: () => query } } as unknown as typeof current);
  const pending = tools.imports_status.execute();
  await started;
  vi.mocked(requireWorkspace).mockResolvedValue({ ...current, settings: { ...DEFAULT_SETTINGS, ai_data_scopes: ["accounts", "transactions", "planning"] } });
  release({ data: [{ id: "synthetic-import", filename: "synthetic.csv" }], error: null });
  await expect(pending).rejects.toThrow(/disabled/);
});

it("uses freshly checked workspace context for shared reads and denies a changed workspace", async () => {
  await POST(request("Read my accounts"));
  const current = await requireWorkspace();
  const tools = vi.mocked(generateText).mock.calls[0][0].tools as unknown as Record<string, { execute: () => Promise<unknown> }>;
  await tools.accounts_list.execute();
  expect(listAccounts).toHaveBeenCalledWith(current);
  vi.mocked(listAccounts).mockClear();
  vi.mocked(requireWorkspace).mockResolvedValue({ ...current, workspace: { ...current.workspace, id: "different-workspace" } });
  await expect(tools.accounts_list.execute()).rejects.toThrow("Workspace changed");
  expect(listAccounts).not.toHaveBeenCalled();
});

it("denies a workspace change during a read before releasing its result", async () => {
  await POST(request("Read my accounts"));
  const current = await requireWorkspace();
  const tools = vi.mocked(generateText).mock.calls[0][0].tools as unknown as Record<string, { execute: () => Promise<unknown> }>;
  vi.mocked(listAccounts).mockImplementationOnce(async () => {
    vi.mocked(requireWorkspace).mockResolvedValue({ ...current, workspace: { ...current.workspace, id: "different-workspace" } });
    return { synthetic: "withheld" } as never;
  });
  await expect(tools.accounts_list.execute()).rejects.toThrow("Workspace changed");
});

it("investigates remaining evidence when planning is already revoked before a new read", async () => {
  await POST(request("Review my finances"));
  const current = await requireWorkspace();
  const reduced = { ...current, settings: { ...DEFAULT_SETTINGS, ai_data_scopes: ["accounts", "transactions"] as const } };
  vi.mocked(requireWorkspace).mockResolvedValue(reduced as unknown as typeof current);
  const tools = vi.mocked(generateText).mock.calls[0][0].tools as unknown as Record<string, { execute: () => Promise<unknown> }>;
  await expect(tools.reviews_investigate.execute()).resolves.toEqual({ source: "exact evidence" });
  expect(loadFinancialReviewEvidence).toHaveBeenCalledWith(current.supabase, current.workspace, reduced.settings);
});

it("preserves the separately authorized exact category command after data-scope revocation", async () => {
  await POST(request(`Set category of transaction ${requestId} to "Groceries"`));
  const current = await requireWorkspace();
  vi.mocked(requireWorkspace).mockResolvedValue({ ...current, settings: { ...DEFAULT_SETTINGS, ai_data_scopes: [] } });
  const tools = vi.mocked(generateText).mock.calls[0][0].tools as unknown as Record<string, { execute: (input: unknown) => Promise<unknown> }>;
  await tools.transactions_setCategory.execute({ transactionId: requestId, category: "Groceries" });
  expect(current.supabase.rpc).toHaveBeenCalledWith("chat_set_category", { p_request_id: requestId, p_transaction_id: requestId, p_category: "Groceries" });
  await expect(tools.transactions_setCategory.execute({ transactionId: requestId, category: "Other" })).rejects.toThrow("Action must match");
});
