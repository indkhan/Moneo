import { beforeEach, expect, it, vi } from "vitest";
import { generateText } from "ai";
import { investigationDetail } from "@/lib/finance/investigation-reader";
import { POST } from "./route";
import { requireWorkspace } from "@/lib/auth";
import { DEFAULT_SETTINGS, requireAiScope, type AiDataScope } from "@/lib/settings";
import { loadCategoryPreview } from "@/lib/finance/edit-preview";
import { loadFinancialReviewEvidence } from "@/lib/finance/review-loader";
import { listAccounts, getBalances, cashflow, searchTransactions, listGoals, evaluateForecast } from "@/lib/finance/tools";
import { startFinancialReview } from "@/lib/finance/start-review";
import { captureToolEvidence } from "@/lib/finance/capture-evidence";
import { toolResultReceipt } from "@/lib/finance/tool-evidence";
const { serviceRpc } = vi.hoisted(() => ({ serviceRpc: vi.fn(async (name: string, args: Record<string, unknown>) => { void name; void args; return { error: null, data: "completed" }; }) }));
vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn(() => ({ rpc: serviceRpc })) }));
vi.mock("@/lib/finance/investigation-reader", async original => ({ ...await original<typeof import("@/lib/finance/investigation-reader")>(), investigationDetail: vi.fn(async () => ({ synthetic: "detail" })) }));
vi.mock("ai", () => ({ generateText: vi.fn(async () => ({ text: "Evidence reviewed", totalUsage: {} })), tool: (value: unknown) => value, stepCountIs: (value: number) => value }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));
vi.mock("@/lib/ai/provider", () => ({ SYSTEM_PROMPT: "", modelForSettings: vi.fn(async () => ({ modelId: "free" })) }));
vi.mock("@/lib/finance/start-review", () => ({ startFinancialReview: vi.fn(async () => ({ jobId: "job", status: "queued" })) }));
vi.mock("@/lib/finance/capture-evidence", () => ({ captureToolEvidence: vi.fn(async () => []) }));
vi.mock("@/lib/finance/review-loader", () => ({ loadFinancialReviewEvidence: vi.fn(async () => ({ source: "exact evidence" })) }));
vi.mock("@/lib/finance/edit-preview", async original => ({ ...await original<typeof import("@/lib/finance/edit-preview")>(), loadCategoryPreview: vi.fn(async () => ({ href: "/ai/actions/preview?ids=selected&category=owned", warning: "Preview only" })) }));
vi.mock("@/lib/finance/tools", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/finance/tools")>()),
  ...Object.fromEntries(["listAccounts", "getBalances", "cashflow", "searchTransactions", "listGoals", "evaluateForecast"].map(name => [name, vi.fn(async () => ({ synthetic: name }))])),
}));
beforeEach(() => {
  vi.clearAllMocks(); process.env.OPENROUTER_API_KEY = "test"; process.env.SUPABASE_SERVICE_ROLE_KEY = "test"; process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.test";
  vi.mocked(investigationDetail).mockReset().mockResolvedValue({ synthetic: "detail" } as never);
  const query = { select: () => query, eq: () => query, order: () => query, limit: async () => ({ data: [], error: null }), maybeSingle: async () => ({ data: { id: "conversation" }, error: null }) };
  const rpc = vi.fn(async (name: string) => ({ error: null, data: name === "start_chat_request" ? { started: true } : "completed" }));
  vi.mocked(requireWorkspace).mockResolvedValue({ supabase: { from: () => query, rpc }, user: { id: "00000000-0000-4000-8000-000000000099" }, workspace: { id: "workspace", display_currency: "EUR" }, settings: DEFAULT_SETTINGS } as unknown as Awaited<ReturnType<typeof requireWorkspace>>);
});
const requestId = "00000000-0000-4000-8000-000000000001";
const request = (message: string) => new Request("http://localhost/api/chat", { method: "POST", body: JSON.stringify({ conversationId: "00000000-0000-4000-8000-000000000002", requestId, message }) });
async function withHistory(rows: { role: string; content: string; context?: unknown }[], scopes: AiDataScope[] = [...DEFAULT_SETTINGS.ai_data_scopes]) {
  const current = await requireWorkspace();
  const query = { select: () => query, eq: () => query, order: () => query,
    limit: async (size: number) => ({ data: rows.slice(0, size), error: null }),
    maybeSingle: async () => ({ data: { id: "conversation" }, error: null }) };
  vi.mocked(requireWorkspace).mockResolvedValue({ ...current, settings: { ...DEFAULT_SETTINGS, ai_data_scopes: scopes },
    supabase: { ...current.supabase, from: () => query } } as unknown as typeof current);
}
it("keeps permitted planning dialogue when imports are disabled, without replaying import evidence", async () => {
  await withHistory([
    { role: "user", content: "Explain the second option" },
    { role: "assistant", content: "Option one: review goals. Option two: explore forecast assumptions.", context: { memory: { version: 1, kind: "dialogue", scopes: ["planning"] } } },
    { role: "assistant", content: "Private import filename secret-statement.csv", context: { memory: { version: 1, kind: "evidence", scopes: ["imports"] } } },
  ], ["accounts", "transactions", "planning"]);
  expect((await POST(request("Explain the second option"))).status).toBe(200);
  const prompt = JSON.stringify(vi.mocked(generateText).mock.calls[0][0].messages);
  expect(prompt).toContain("Option two: explore forecast assumptions");
  expect(prompt).not.toContain("secret-statement.csv");
});
it("retains an early decision through fifty turns within a declared context budget", async () => {
  const rows = Array.from({ length: 50 }, (_, index) => [
    { role: "user", content: index === 0 ? "Decision: compare September with August using original currencies." : `Follow-up ${index}: explain the chosen comparison.` },
    { role: "assistant", content: "Which dates should I compare?", context: { memory: { version: 1, kind: "dialogue", scopes: [] } } },
  ]).flat().reverse();
  await withHistory(rows);
  expect((await POST(request("Use our earlier decision"))).status).toBe(200);
  const prompt = JSON.stringify(vi.mocked(generateText).mock.calls[0][0].messages);
  expect(prompt).toContain("Decision: compare September with August using original currencies.");
  expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(16000);
  expect(vi.mocked(generateText).mock.calls[0][0].system).toContain("Historical dialogue is not current financial evidence");
});
it("withholds prior financial prose after corrections even when its scopes remain allowed", async () => {
  await withHistory([
    { role: "user", content: "What is the corrected amount now?" },
    { role: "assistant", content: "Old booked amount EUR 999.99", context: { memory: { version: 1, kind: "evidence", scopes: ["transactions"], receiptIds: [requestId] } } },
  ]);
  expect((await POST(request("What is the corrected amount now?"))).status).toBe(200);
  expect(JSON.stringify(vi.mocked(generateText).mock.calls[0][0].messages)).not.toContain("999.99");
});
it("rejects malformed selection IDs before claiming a request or calling a provider", async () => {
  const response = await POST(new Request("http://localhost/api/chat", { method: "POST", body: JSON.stringify({
    conversationId: requestId, requestId, message: "Explain this transaction", context: { selected: [{ kind: "transaction", id: "invented" }] },
  }) }));
  expect(response.status).toBe(400);
  expect(generateText).not.toHaveBeenCalled();
  expect((await requireWorkspace()).supabase.rpc).not.toHaveBeenCalled();
});
it("resolves a stable selected transaction using current owned evidence before asking the provider", async () => {
  const selectedId = "00000000-0000-4000-8000-000000000088";
  vi.mocked(investigationDetail).mockResolvedValueOnce({ kind: "transaction", transaction: { id: selectedId, version: 2, amount_minor: "1250", currency_code: "EUR" } } as never);
  const response = await POST(new Request("http://localhost/api/chat", { method: "POST", body: JSON.stringify({
    conversationId: requestId, requestId, message: "Explain this transaction", context: { selected: [{ kind: "transaction", id: selectedId }] },
  }) }));
  expect(response.status).toBe(200);
  expect(investigationDetail).toHaveBeenCalledWith({ kind: "transaction", id: selectedId }, expect.anything(), { canReadImports: true });
  const prompt = JSON.stringify(vi.mocked(generateText).mock.calls[0][0].messages);
  expect(prompt).toContain(selectedId);
  expect(prompt).toContain("1250");
  expect(vi.mocked(generateText).mock.calls[0][0].messages?.at(-1)).toMatchObject({ content: expect.stringContaining('"version":2') });
});
it("does not resolve selected records under revoked transaction scope", async () => {
  await withHistory([], ["planning"]);
  const response = await POST(new Request("http://localhost/api/chat", { method: "POST", body: JSON.stringify({
    conversationId: requestId, requestId, message: "Explain this transaction", context: { selected: [{ kind: "transaction", id: requestId }] },
  }) }));
  expect(response.status).toBe(200);
  expect(investigationDetail).not.toHaveBeenCalled();
  expect(JSON.stringify(vi.mocked(generateText).mock.calls[0][0].messages)).toContain("Selected transaction evidence is unavailable under current permissions");
});
it("persists the exact prompt snapshot and trusted dialogue provenance at successful publication", async () => {
  expect((await POST(request("Hello"))).status).toBe(200);
  const publication = serviceRpc.mock.calls.find(call => call[0] === "finish_contextual_chat_request")?.[1];
  expect(publication).toMatchObject({ p_prompt_context: {
    memory: { version: 1, kind: "dialogue", scopes: [], receiptIds: [] },
    assembly: { budgetBytes: 16000 },
    messages: vi.mocked(generateText).mock.calls[0][0].messages,
  } });
});
it("removes unsupported provider amounts and links before either response or immutable history publication", async () => {
  vi.mocked(generateText).mockResolvedValueOnce({ text: "You spent EUR 999999.00 [proof](/money/transactions?transaction=missing)", totalUsage: {} } as never);
  const response = await POST(request("Explain my spending"));
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(body.answer).toContain("Unsupported sections were removed");
  expect(body.answer).not.toContain("999999");
  expect(body.answer).not.toContain("transaction=missing");
  expect(serviceRpc.mock.calls.find(call => call[0] === "finish_contextual_chat_request")?.[1]).toMatchObject({ p_content: body.answer });
});
it("publishes supported tool claims with application amounts and calculation links", async () => {
  const context = await requireWorkspace();
  context.workspace.id = "00000000-0000-4000-8000-000000000010";
  const receipt = toolResultReceipt("analytics_cashflow", {}, { currencyCode: "EUR", from: "2026-09-01", to: "2026-09-30", spendingMinor: "25" }, { workspaceId: context.workspace.id, fetchedAt: "2026-10-01T00:00:00Z", timezone: "UTC" }, ["transactions"]);
  vi.mocked(captureToolEvidence).mockResolvedValueOnce([receipt]);
  vi.mocked(generateText).mockImplementationOnce(async options => {
    const tools = options.tools as unknown as Record<string, { execute: (input: unknown, options: unknown) => Promise<unknown> }>;
    const output = await tools.analytics_cashflow.execute({ from: "2026-09-01", to: "2026-09-30", currencyCode: "EUR" }, {});
    expect(output).toMatchObject({ evidenceReceipts: [{ id: receipt.id, metrics: receipt.metrics }] });
    const metric = receipt.metrics[0];
    return { text: JSON.stringify({ claims: [{ operation: "metric", operands: [{ receiptId: receipt.id, metricId: metric.id }], valueMinor: "25", currency: "EUR", periods: [metric.period], qualifiers: metric.qualifiers }], interpretation: [] }), totalUsage: {} } as never;
  });
  const response = await POST(request("Show September spending")), body = await response.json();
  expect(response.status).toBe(200);
  expect(body.answer).toContain("EUR 0.25");
  expect(body.answer).toContain(`/ai/evidence/${receipt.id}?metric=spendingMinor`);
  expect(body.answer).not.toContain("Unsupported sections");
  expect(serviceRpc.mock.calls.find(call => call[0] === "finish_contextual_chat_request")?.[1]).toMatchObject({ p_content: body.answer });
});
it("offers scoped investigation and question-bound review start within four model steps", async () => {
  expect((await POST(request("Start a deep financial review"))).status).toBe(200);
  const options = vi.mocked(generateText).mock.calls[0][0];
  expect(options.stopWhen).toBe(4);
  const tools = options.tools as unknown as Record<string, { execute: () => Promise<unknown> }>;
  expect(await tools.reviews_investigate.execute()).toEqual({ source: "exact evidence" });
  expect(await tools.reviews_start.execute()).toMatchObject({ jobId: "job", status: "queued", href: "/ai" });
  expect(startFinancialReview).toHaveBeenCalledWith(expect.anything(), "workspace", requestId, requestId, expect.objectContaining({question: "Start a deep financial review"}));
});
it.each(["Run a deep financial review for September", "Review my finances and focus on subscriptions", "Investigate the decline in grocery spending"])("accepts ordinary investigation phrasing and retains exact question, chosen dates and focus: %s", async message => {
  await POST(request(message));
  const tools = vi.mocked(generateText).mock.calls[0][0].tools as unknown as Record<string, {execute: (input: unknown) => Promise<unknown>}>;
  expect(tools).toHaveProperty("reviews_start");
  const query = {version: 1, period: {from: "2026-09-01", to: "2026-09-30"}, comparison: {from: "2026-08-01", to: "2026-08-31"}, groupBy: ["merchant"]};
  await tools.reviews_start.execute({query, focus: "Subscriptions", output: "answer"});
  expect(startFinancialReview).toHaveBeenLastCalledWith(expect.anything(), "workspace", requestId, requestId, expect.objectContaining({question: message, query: expect.objectContaining(query), focus: "Subscriptions", output: "answer"}));
});
it("binds review navigation hints and read policy to actual submission rather than model replacements", async () => {
  const visible = {page: "/money/investigations", accountId: "selected-owned"};
  await POST(new Request("http://localhost/api/chat", {method: "POST", body: JSON.stringify({conversationId: "00000000-0000-4000-8000-000000000002", requestId, message: "Explain the selected spending change", context: visible})}));
  const tools = vi.mocked(generateText).mock.calls[0][0].tools as unknown as Record<string, {execute: (input: unknown) => Promise<unknown>}>;
  await tools.reviews_start.execute({context: {page: "forged"}, allowedScopes: ["imports"]});
  expect(startFinancialReview).toHaveBeenLastCalledWith(expect.anything(), "workspace", requestId, requestId, expect.objectContaining({context: visible, allowedScopes: DEFAULT_SETTINGS.ai_data_scopes}));
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
  ["accounts_getBalances", "imports", getBalances], ["analytics_cashflow", "imports", cashflow],
  ["forecast_evaluate", "imports", evaluateForecast], ["reviews_investigate", "imports", loadFinancialReviewEvidence],
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
    const result = tools[name].execute(name === "reviews_start" ? {} : { query: "synthetic", from: "2026-10-01", to: "2026-10-02", currencyCode: "EUR", horizonDays: 30, transactionIds: [requestId], categoryId: requestId });
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
  expect(loadFinancialReviewEvidence).toHaveBeenCalledWith(current.supabase, current.workspace, reduced.settings, undefined);
});
it("publishes successful validated answers through service-only owned publication", async () => {
  const context = await requireWorkspace();
  const response = await POST(new Request("http://localhost/api/chat", { method: "POST", body: JSON.stringify({ conversationId: "00000000-0000-4000-8000-000000000001", requestId: "00000000-0000-4000-8000-000000000002", message: "Hello" }) }));
  expect(response.status).toBe(200);
  expect(serviceRpc).toHaveBeenCalledWith("finish_contextual_chat_request", expect.objectContaining({ p_request_id: "00000000-0000-4000-8000-000000000002", p_receipt_ids: [], p_scopes: [] }));
  expect(vi.mocked(context.supabase.rpc).mock.calls.some(call => call[0] === "finish_chat_request" && call[1]?.p_status === "completed")).toBe(false);
});
it("publishes a useful typed clarification when no financial measure is needed", async () => {
  vi.mocked(generateText).mockResolvedValueOnce({ text: JSON.stringify({ claims: [], interpretation: [], clarification: { topic: "period" } }), totalUsage: {} } as never);
  const response = await POST(request("Please compare my spending")), body = await response.json();
  expect(response.status).toBe(200);
  expect(body.answer).toContain("What start and end dates");
  expect(body.answer).not.toContain("No supported financial measures");
  expect(body.answer).not.toContain("Unsupported sections");
  expect(serviceRpc.mock.calls.find(call => call[0] === "finish_contextual_chat_request")?.[1]).toMatchObject({ p_content: body.answer });
});
it.each(["planning", "imports"] as const)("carries actual %s reads across a revocation between post-read and capture", async revoked => {
  await POST(request("Review my finances"));
  const current = await requireWorkspace();
  let checks = 0;
  vi.mocked(loadFinancialReviewEvidence).mockImplementationOnce(async () => {
    vi.mocked(requireWorkspace).mockImplementation(async () => ++checks === 1 ? current : { ...current, settings: { ...DEFAULT_SETTINGS, ai_data_scopes: DEFAULT_SETTINGS.ai_data_scopes.filter(scope => scope !== revoked) } });
    return { planning: { synthetic: "retained" } } as never;
  });
  vi.mocked(captureToolEvidence).mockImplementationOnce(async (...args) => {
    const scopes = (args as unknown[])[5] as AiDataScope[];
    requireAiScope(args[3].settings, ...scopes);
    return [];
  });
  const tools = vi.mocked(generateText).mock.calls[0][0].tools as unknown as Record<string, { execute: () => Promise<unknown> }>;
  await expect(tools.reviews_investigate.execute()).rejects.toThrow(new RegExp(`${revoked}.*disabled`));
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

it.each(["before", "during"])("requires planning for recurring detail when revoked %s the read", async when => {
  await POST(request("Explain my transactions"));
  const context = await requireWorkspace();
  const revoked = { ...context, settings: { ...context.settings, ai_data_scopes: ["accounts", "transactions"] as typeof context.settings.ai_data_scopes } };
  if (when === "before") vi.mocked(requireWorkspace).mockResolvedValue(revoked);
  else vi.mocked(investigationDetail).mockImplementationOnce(async () => { vi.mocked(requireWorkspace).mockResolvedValue(revoked); return { series: {} } as unknown as Awaited<ReturnType<typeof investigationDetail>>; });
  const tools = vi.mocked(generateText).mock.calls[0][0].tools as unknown as Record<string, { execute: (input: unknown) => Promise<unknown> }>;
  await expect(tools.finance_detail.execute({ kind: "recurring", id: requestId })).rejects.toThrow(/disabled/);
  if (when === "before") expect(investigationDetail).not.toHaveBeenCalled();
});
it("allows transaction detail with planning disabled", async () => {
  await POST(request("Explain my transactions"));
  const context = await requireWorkspace();
  vi.mocked(requireWorkspace).mockResolvedValue({ ...context, settings: { ...context.settings, ai_data_scopes: ["accounts", "transactions"] } });
  const tools = vi.mocked(generateText).mock.calls[0][0].tools as unknown as Record<string, { execute: (input: unknown) => Promise<unknown> }>;
  await expect(tools.finance_detail.execute({ kind: "transaction", id: requestId })).resolves.toEqual({ synthetic: "detail" });
});

