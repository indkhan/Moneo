import { beforeEach, expect, it, vi } from "vitest";
import { investigationDetail } from "@/lib/finance/investigation-reader";
import { POST } from "./route";
import { requireWorkspace } from "@/lib/auth";
import { DEFAULT_SETTINGS } from "@/lib/settings";
import { loadCategoryPreview } from "@/lib/finance/edit-preview";
import { loadFinancialReviewEvidence } from "@/lib/finance/review-loader";
import { listAccounts, getBalances, cashflow, searchTransactions, listGoals, evaluateForecast } from "@/lib/finance/tools";
import { startFinancialReview } from "@/lib/finance/start-review";
// The model run is mocked as one async call returning the final text and steps; streamText wraps it.
type Run = { text: string; usage?: unknown; steps?: unknown[] };
const { generateText } = vi.hoisted(() => ({ generateText: vi.fn(async (options: { tools: unknown; stopWhen?: unknown; instructions?: string; messages?: unknown }): Promise<Run> => { void options; return { text: "Evidence reviewed" }; }) }));
vi.mock("@/lib/finance/investigation-reader", async original => ({ ...await original<typeof import("@/lib/finance/investigation-reader")>(), investigationDetail: vi.fn(async () => ({ synthetic: "detail" })) }));
vi.mock("ai", () => ({ tool: (value: unknown) => value, stepCountIs: (value: number) => value, streamText: (options: Parameters<typeof generateText>[0]) => {
  const run = generateText(options);
  run.catch(() => {});
  return { fullStream: (async function* () { const { text } = await run; yield { type: "text-delta", text }; yield { type: "finish-step" }; })(),
    usage: run.then(result => result.usage ?? {}), steps: run.then(result => result.steps ?? []) };
} }));
vi.mock("@/lib/auth", () => ({ requireWorkspace: vi.fn() }));
vi.mock("@/lib/ai/provider", () => ({ SYSTEM_PROMPT: "", modelForSettings: vi.fn(async () => ({ modelId: "free" })) }));
vi.mock("@/lib/finance/start-review", () => ({ startFinancialReview: vi.fn(async () => ({ jobId: "job", status: "queued" })) }));
vi.mock("@/lib/finance/review-loader", () => ({ loadFinancialReviewEvidence: vi.fn(async () => ({ source: "exact evidence" })) }));
vi.mock("@/lib/finance/edit-preview", async original => ({ ...await original<typeof import("@/lib/finance/edit-preview")>(), loadCategoryPreview: vi.fn(async () => ({ href: "/ai/actions/preview?ids=selected&category=owned", warning: "Preview only" })) }));
vi.mock("@/lib/finance/tools", async importOriginal => ({
  ...(await importOriginal<typeof import("@/lib/finance/tools")>()),
  ...Object.fromEntries(["listAccounts", "getBalances", "cashflow", "searchTransactions", "listGoals", "evaluateForecast"].map(name => [name, vi.fn(async () => ({ synthetic: name }))])),
}));
beforeEach(() => {
  vi.clearAllMocks(); process.env.OPENAI_API_KEY = "test"; process.env.SUPABASE_SERVICE_ROLE_KEY = "test"; process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.test";
  const query = { select: () => query, eq: () => query, order: () => query, limit: async () => ({ data: [], error: null }), maybeSingle: async () => ({ data: { id: "conversation" }, error: null }) };
  const rpc = vi.fn(async (name: string) => ({ error: null, data: name === "start_chat_request" ? { started: true } : "completed" }));
  vi.mocked(requireWorkspace).mockResolvedValue({ supabase: { from: () => query, rpc }, user: { id: "00000000-0000-4000-8000-000000000099" }, workspace: { id: "workspace", display_currency: "EUR" }, settings: DEFAULT_SETTINGS } as unknown as Awaited<ReturnType<typeof requireWorkspace>>);
});
const requestId = "00000000-0000-4000-8000-000000000001";
const request = (message: string) => new Request("http://localhost/api/chat", { method: "POST", body: JSON.stringify({ conversationId: "00000000-0000-4000-8000-000000000002", requestId, message }) });
it("publishes the model's own Markdown answer with usage and tool calls", async () => {
  vi.mocked(generateText).mockImplementationOnce(async options => {
    const tools = options.tools as unknown as Record<string, { execute: (input: unknown, options: unknown) => Promise<unknown> }>;
    await tools.accounts_list.execute({}, { toolCallId: "call" });
    return { text: "You spent **EUR 12.00**.", usage: { inputTokens: 5, outputTokens: 7, totalTokens: 12 } };
  });
  const response = await POST(request("Explain my spending"));
  const body = await response.json();
  expect(response.status).toBe(200);
  expect(body.answer).toBe("You spent **EUR 12.00**.");
  const context = await requireWorkspace();
  expect(vi.mocked(context.supabase.rpc).mock.calls.find(call => call[0] === "finish_chat_request")?.[1]).toMatchObject({ p_status: "completed", p_content: body.answer,
    p_usage: { model_id: "free" }, p_tool_calls: [{ name: "accounts_list", input: {}, output: expect.stringContaining("listAccounts") }] });
});
it("gives the model readable tool output without internal evidence", async () => {
  vi.mocked(cashflow).mockResolvedValueOnce({ currencyCode: "EUR", spendingMinor: "2500", calculationEvidence: { rows: [] } } as never);
  await POST(request("Show September spending"));
  const tools = vi.mocked(generateText).mock.calls[0][0].tools as unknown as Record<string, { execute: (input: unknown, options: unknown) => Promise<unknown> }>;
  expect(await tools.analytics_cashflow.execute({ from: "2026-09-01", to: "2026-09-30", currencyCode: "EUR" }, {})).toEqual({ currencyCode: "EUR", spendingMinor: "2500", spendingFormatted: "EUR 25.00" });
});
it("keeps earlier assistant turns in history without their chart blocks", async () => {
  const context = await requireWorkspace();
  const history = [{ role: "assistant", content: "Here:\n```chart\n{\"type\":\"bar\"}\n```\nDone", context: null }, { role: "user", content: "Earlier", context: {} }];
  const query = { select: () => query, eq: () => query, order: () => query, limit: async () => ({ data: history, error: null }), maybeSingle: async () => ({ data: { id: "conversation" }, error: null }) };
  vi.mocked(requireWorkspace).mockResolvedValue({ ...context, settings: { ...DEFAULT_SETTINGS, ai_data_scopes: ["accounts"] }, supabase: { ...context.supabase, from: () => query } } as unknown as typeof context);
  await POST(request("And now?"));
  expect(vi.mocked(generateText).mock.calls[0][0].messages).toEqual([{ role: "user", content: "Earlier" }, { role: "assistant", content: "Here:\n[chart]\nDone" }, { role: "user", content: "And now?" }]);
});
it("offers scoped investigation and question-bound review start within ten model steps", async () => {
  expect((await POST(request("Start a deep financial review"))).status).toBe(200);
  const options = vi.mocked(generateText).mock.calls[0][0];
  expect(options.stopWhen).toBe(10);
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

it("shows the model's plan as a stream event and returns follow-ups without treating them as evidence", async () => {
  vi.mocked(generateText).mockImplementationOnce(async options => {
    const tools = options.tools as unknown as Record<string, { execute: (input: unknown) => Promise<unknown> }>;
    expect(await tools.plan_investigation.execute({ steps: ["Compare September with August", "Rank categories by change"], followUps: ["Which merchant grew most?"] })).toEqual({ shown: true });
    return { text: "Done", steps: [{ toolResults: [{ toolName: "plan_investigation" }, { toolName: "finance_investigate" }] }] };
  });
  const response = await POST(new Request("http://localhost/api/chat", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
    body: JSON.stringify({ conversationId: requestId, requestId, message: "Why did I spend more in September?" }) }));
  const events = (await response.text()).trim().split("\n").map(line => JSON.parse(line));
  expect(events).toContainEqual({ type: "plan", steps: ["Compare September with August", "Rank categories by change"] });
  const result = events.find(event => event.type === "result").body;
  expect(result.followUps.map((item: { label: string }) => item.label)).toEqual(["Which merchant grew most?", "Break this down by merchant", "Compare with the same period last year", "Start a deep review"]);
});

it("returns only completed tool names from actual model steps, without leaking tool inputs or results", async () => {
  vi.mocked(generateText).mockResolvedValueOnce({ text: "Done", steps: [
    { toolResults: [{ toolName: "transactions_search", output: { private: "record" } }, { toolName: "accounts_list" }] },
    { toolResults: [undefined, { toolName: "transactions_search" }] },
  ] } as never);
  const result = await (await POST(request("Create a spending chart"))).json();
  expect(result.toolsUsed).toEqual(["transactions_search", "accounts_list"]);
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
    return { text: "Permission unavailable" };
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
it.each(["planning", "imports"] as const)("carries actual %s reads across a revocation after the read", async revoked => {
  await POST(request("Review my finances"));
  const current = await requireWorkspace();
  let checks = 0;
  vi.mocked(loadFinancialReviewEvidence).mockImplementationOnce(async () => {
    vi.mocked(requireWorkspace).mockImplementation(async () => ++checks === 1 ? current : { ...current, settings: { ...DEFAULT_SETTINGS, ai_data_scopes: DEFAULT_SETTINGS.ai_data_scopes.filter(scope => scope !== revoked) } });
    return { planning: { synthetic: "retained" } } as never;
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

it("streams tool progress, answer text and the answer before durable publication finishes", async () => {
  let publish!: () => void;
  const context = await requireWorkspace();
  vi.mocked(context.supabase.rpc).mockImplementation((async (name: string) => name === "finish_chat_request" ? new Promise(resolve => { publish = () => resolve({ error: null, data: "completed" }); }) : { error: null, data: { started: true } }) as never);
  vi.mocked(generateText).mockImplementationOnce(async options => {
    const tools = options.tools as unknown as Record<string, { execute: (input: unknown, options: unknown) => Promise<unknown> }>;
    await tools.accounts_list.execute({}, { toolCallId: "call" });
    return { text: "Evidence reviewed", steps: [] };
  });
  const streamed = new Request("http://localhost/api/chat", { method: "POST", headers: { Accept: "application/x-ndjson" }, body: JSON.stringify({ conversationId: "00000000-0000-4000-8000-000000000002", requestId, message: "List accounts" }) });
  const response = await POST(streamed);
  expect(response.headers.get("content-type")).toContain("application/x-ndjson");
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let text = "";
  while (!text.includes('"type":"answer"')) text += (await reader.read()).value ?? "";
  expect(text).toContain('{"type":"tool","id":"call","name":"accounts_list","state":"running","input":{}}');
  expect(text).toContain('"state":"done"');
  expect(text).toContain('{"type":"delta","text":"Evidence reviewed"}');
  expect(text).not.toContain('"type":"result"');
  await vi.waitFor(() => expect(publish).toBeTypeOf("function"));
  publish();
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) text += chunk.value;
  expect(JSON.parse(text.trim().split("\n").at(-1)!)).toMatchObject({ type: "result", status: 200, body: { conversationId: "00000000-0000-4000-8000-000000000002" } });
});

