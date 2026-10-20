import { streamText, tool, stepCountIs, type ToolSet, type ToolExecutionOptions } from "ai";
import { z } from "zod";
import { modelForSettings, SYSTEM_PROMPT } from "@/lib/ai/provider";
import { requireWorkspace } from "@/lib/auth";
import { requireAiScope, type AiDataScope } from "@/lib/settings";
import { calendarDate } from "@/lib/finance/calendar";
import { reportedUsage } from "@/lib/ai/usage";
import { parseCategoryCommand } from "@/lib/ai/write-intent";
import {reviewRequestSchema, resolveReviewRequest} from "@/lib/finance/review-request";
import { loadFinancialReviewEvidence } from "@/lib/finance/review-loader";
import { startFinancialReview } from "@/lib/finance/start-review";
import { categoryPreviewSchema, loadCategoryPreview } from "@/lib/finance/edit-preview";
import { cashflow, evaluateForecast, financeToolSchemas, forecastInput, getBalances, listAccounts, listGoals, searchTransactions } from "@/lib/finance/tools";
import { investigationSchema } from "@/lib/finance/investigation";
import { evaluateInvestigationScenario, investigationDetail, investigationDetailSchema, investigationScenarioSchema, loadInvestigationEntities, runInvestigation } from "@/lib/finance/investigation-reader";
import type { ChatStreamEvent } from "@/lib/ai/use-chat-request";
import { chatFollowUps, planInput } from "@/lib/ai/follow-ups";
import { readableToolOutput, toolOutputPreview, type EntityNames } from "@/lib/ai/tool-output";

/** Chart blocks are rendered for people; the model only needs to know one was shown. */
function withoutCharts(content: string) {
  return content.replace(/```(?:chart|moneo-chart)\n[\s\S]*?```/g, "[chart]");
}

const inputSchema = z.object({
  conversationId: z.uuid(),
  requestId: z.uuid(),
  message: z.string().trim().min(1).max(4000),
  context: z.record(z.string(), z.unknown()).optional(),
}).strict();

export async function POST(request: Request) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const body = await request.json().catch(() => null);
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success || JSON.stringify(parsed.data.context ?? {}).length > 2000)
    return Response.json({ error: "Invalid message" }, { status: 400 });
  if (!(process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY)) return Response.json({ error: "AI is not configured" }, { status: 503 });
  const { conversationId, requestId, message, context: capturedContext } = parsed.data;
  const { supabase, workspace, settings } = context;
  // Model resolution and earlier history do not depend on the claim; start them with the ownership check.
  const modelPromise = modelForSettings(settings, "chat");
  const historyPromise = Promise.resolve(supabase.from("messages").select("role, content, context")
    .eq("workspace_id", workspace.id).eq("conversation_id", conversationId)
    .order("created_at", { ascending: false }).limit(19));
  modelPromise.catch(() => {});
  historyPromise.catch(() => {});
  const existing = await supabase.from("conversations").select("id, deleted_at").eq("workspace_id", workspace.id).eq("id", conversationId).maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data?.deleted_at) return Response.json({ error: "Conversation was deleted" }, { status: 404 });
  if (!existing.data) {
    const { error } = await supabase.from("conversations").insert({ id: conversationId, workspace_id: workspace.id, title: message.slice(0, 80) });
    if (error && error.code !== "23505") return Response.json({ error: "Conversation unavailable" }, { status: 403 });
  }
  const claim = await supabase.rpc("start_chat_request", {
    p_request_id: requestId, p_conversation_id: conversationId, p_message: message, p_context: capturedContext ?? {},
  });
  if (claim.error) return Response.json({ error: claim.error.message }, { status: 400 });
  if (!claim.data.started) {
    if (claim.data.status === "completed") return Response.json({ conversationId, answer: claim.data.answer });
    return Response.json({ error: `Request is ${claim.data.status}`, status: claim.data.status }, { status: 409 });
  }
  if (request.signal.aborted) {
    await supabase.rpc("cancel_chat_request", { p_request_id: requestId });
    return Response.json({ status: "canceled" }, { status: 409 });
  }
  const streaming = request.headers.get("accept")?.includes("application/x-ndjson") ?? false;
  async function complete(emit: (event: ChatStreamEvent) => void): Promise<[unknown, number]> {
  try {
  const { data: history, error: historyError } = await historyPromise;
  if (historyError) throw historyError;
  // History was read before the claim saved this message, so append it exactly as the claim stores it.
  const submitted = { role: "user", content: message, context: capturedContext ?? {} };
  const modelMessages = [...(history ?? []).reverse(), submitted].map(item => ({
    role: item.role as "user" | "assistant",
    content: item.role === "assistant" ? withoutCharts(item.content)
      : item.context && Object.keys(item.context).length ? `${item.content}\n[UI context at submission: ${JSON.stringify(item.context)}]` : item.content,
  }));
  const categoryCommand = parseCategoryCommand(message);
  const canChangeCategory = categoryCommand !== null && settings.ai_data_scopes.includes("transactions");
  const canInvestigate = settings.ai_data_scopes.includes("accounts") && settings.ai_data_scopes.includes("transactions");
  const canCreateArtifact = /(?:^|[.!?]\s+)(?:please\s+)?(?:(?:can|could)\s+you\s+)?(?:create|build|make)\b[^.!?]*\b(?:chart|artifact|tool|dashboard|tracker|planner)\b/i.test(message);
  // These checks govern new tool results, not evidence already sent to the provider.
  const readScopes = new Set<AiDataScope>();
  async function aiEvidence<T>(scopes: AiDataScope[], read: (latest: typeof context) => Promise<T>, includePlanning = false, includeImports = false): Promise<T> {
    const latest = await requireWorkspace();
    if (latest.workspace.id !== workspace.id) throw new Error("Workspace changed");
    requireAiScope(latest.settings, ...scopes);
    const usedScopes = [...scopes,
      ...(includePlanning && latest.settings.ai_data_scopes.includes("planning") ? ["planning" as const] : []),
      ...(includeImports && latest.settings.ai_data_scopes.includes("imports") ? ["imports" as const] : [])];
    const result = await read(latest);
    const current = await requireWorkspace();
    if (current.workspace.id !== workspace.id) throw new Error("Workspace changed");
    if (request.signal.aborted) throw new Error("Request canceled");
    requireAiScope(current.settings, ...usedScopes);
    for (const scope of usedScopes) readScopes.add(scope);
    return result;
  }
  // Owned names label ids in tool output, so the model never needs a separate lookup step.
  let entityNames: Promise<EntityNames> | undefined;
  function namesFor(latest: typeof context): Promise<EntityNames> {
    return entityNames ??= Promise.all((["account", "category", "merchant"] as const).map(async dimension => {
      if (!latest.settings.ai_data_scopes.includes(dimension === "account" ? "accounts" : "transactions")) return [dimension, new Map<string, string>()] as const;
      const table = dimension === "account" ? "accounts" : dimension === "category" ? "categories" : "merchants";
      const { data, error } = await latest.supabase.from(table).select("id, name").eq("workspace_id", workspace.id).limit(5000);
      if (error) throw error;
      return [dimension, new Map((data ?? []).map((row: { id: string; name: string }) => [row.id, row.name]))] as const;
    })).then(entries => Object.fromEntries(entries));
  }
  let createdArtifact: Promise<{ id: string; href: string }> | undefined;
  const toolCalls: { name: string; input: unknown; output: string }[] = [];
  function retainTools<T extends ToolSet>(tools: T): T {
    return Object.fromEntries(Object.entries(tools).map(([name, definition]) => [name, { ...definition,
      execute: async (input: unknown, options: ToolExecutionOptions<unknown>) => {
        const execute = definition.execute as (input: unknown, options: ToolExecutionOptions<unknown>) => Promise<unknown>;
        emit({ type: "tool", id: options?.toolCallId, name, state: "running", input });
        let output: unknown;
        try { output = await execute(input, options); }
        catch (cause) { emit({ type: "tool", id: options?.toolCallId, name, state: "failed" }); throw cause; }
        const latest = await requireWorkspace();
        if (latest.workspace.id !== workspace.id || request.signal.aborted) throw new Error("Request canceled or workspace changed");
        // Every scope read so far must still be allowed before more data reaches the model.
        requireAiScope(latest.settings, ...readScopes);
        const readable = readableToolOutput(output, await namesFor(latest).catch(() => ({})));
        const preview = toolOutputPreview(readable);
        toolCalls.push({ name, input, output: preview });
        emit({ type: "tool", id: options?.toolCallId, name, state: "done", output: preview });
        return readable;
      },
    }])) as T;
  }
    const model = await modelPromise;
    // The visible plan is not financial evidence; it only tells the user what the model will check.
    let modelFollowUps: string[] = [];
    const planTool = { plan_investigation: tool({ description: "Optional: show the user 2-5 short steps you will take for a multi-part question, and up to 3 follow-up questions they might ask next. Returns nothing.",
      inputSchema: planInput, execute: async input => { emit({ type: "plan", steps: input.steps }); modelFollowUps = input.followUps ?? []; return { shown: true }; } }) };
    const result = streamText({
      model,
      abortSignal: AbortSignal.any([request.signal, AbortSignal.timeout(90_000)]),
      maxOutputTokens: 3000,
      instructions: `${SYSTEM_PROMPT}\n\nToday is ${calendarDate(new Date(), settings.timezone)} (${settings.timezone}); display currency ${workspace.display_currency}. UI context is only a navigation hint, never authorization.${canChangeCategory ? " The user named an exact transaction UUID and quoted category; the write tool must use exactly these values." : " Do not change records; for a category change request, use the selection preview."}`,
      messages: modelMessages,
      stopWhen: stepCountIs(10),
      // Steer messages sent during this run join the conversation before the next model step.
      prepareStep: async ({ messages }) => {
        // Steering is best-effort: a failed claim leaves the steers pending and never fails the answer.
        const steers = await Promise.resolve(supabase.rpc("take_chat_steers", { p_request_id: requestId })).catch(error => ({ data: null, error }));
        if (steers.error) { console.error("take_chat_steers failed", steers.error); return {}; }
        const taken = (steers.data ?? []) as { id: string; content: string }[];
        if (!taken.length) return {};
        emit({ type: "steered", steers: taken });
        return { messages: [...messages, ...taken.map(steer => ({ role: "user" as const, content: steer.content }))] };
      },
      tools: { ...planTool, ...retainTools({
        ...(canInvestigate ? {
          finance_investigate: tool({ description: "Answer the actual chosen finance question deterministically: exact current/comparison dates, include/exclude owned account/category/merchant names or IDs, tags/events, posted/pending and classification semantics, multiple groupings, ranking, and complete paginated support. Original currencies stay separate; base uses direct exact posting-date FX and canonical split rounding. Use returned interpretedFilters and live evidence link; never imply full statements or bounds. Read-only, no approval needed.", inputSchema: investigationSchema, execute: input => aiEvidence(["accounts", "transactions"], latest => runInvestigation(input, latest, { canReadImports: latest.settings.ai_data_scopes.includes("imports") }), false, true) }),
          finance_entities: tool({ description: "Optional: list owned account, category and merchant names with ids, tags and events. Other tools already accept names and label ids with names.", inputSchema: z.object({}).strict(), execute: () => aiEvidence(["accounts", "transactions"], latest => loadInvestigationEntities(latest)) }),
          finance_detail: tool({ description: "Read an owned canonical transaction with its effective split/fee components, or a recurring series with complete paginated source transactions. Classification warnings remain explicit.", inputSchema: investigationDetailSchema, execute: input => aiEvidence(input.kind === "recurring" ? ["accounts", "transactions", "planning"] : ["accounts", "transactions"], latest => investigationDetail(input, latest, { canReadImports: latest.settings.ai_data_scopes.includes("imports") }), false, true) }),
          finance_scenario: tool({ description: "Compare the same investigation against at most 100 hypothetical effective-record amount/date/category overrides. Read-only; canonical ledger, sources, balances and recurrence remain unchanged. Use exact minor-unit strings and owned effective IDs.", inputSchema: investigationScenarioSchema, execute: input => aiEvidence(["accounts", "transactions"], latest => evaluateInvestigationScenario(input, latest, { canReadImports: latest.settings.ai_data_scopes.includes("imports") }), false, true) }),
        } : {}),
        ...(settings.ai_data_scopes.includes("imports") ? { imports_status: tool({
          description: "Read recorded import workflow status and row counts. Completed means processing finished, not that all financial classifications or current balances are complete. Use this to answer whether imports are still running; do not infer status from balance freshness or filenames.",
          inputSchema: z.object({}).strict(), execute: () => aiEvidence(["imports"], async latest => {
            const { data, error } = await latest.supabase.from("imports")
              .select("id, filename, status, total_rows, new_rows, matched_rows, review_rows, classification_review_rows, rejected_rows, error")
              .eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(30);
            if (error) throw error;
            return { imports: data ?? [] };
          }),
        }) } : {}),
        ...(canCreateArtifact ? { artifacts_create: tool({
          description: "Create the trusted financial tool explicitly requested by the user and return its link. Spending Explorer provides a live spending chart; Trip Planner compares a trip cost; Goal Tracker shows savings goals. These are existing templates, not generated custom code. Do not claim unsupported account/category comparisons.",
          inputSchema: z.object({ kind: z.enum(["spending_explorer", "trip_planner", "goal_tracker"]), name: z.string().trim().min(1).max(120) }).strict(),
          execute: async ({ kind, name }) => {
            if (request.signal.aborted) throw new Error("Request canceled");
            return createdArtifact ??= (async () => {
            const latest = await requireWorkspace();
            if (latest.workspace.id !== workspace.id) throw new Error("Workspace changed");
            const { data, error } = await latest.supabase.rpc("create_trusted_artifact", { p_kind: kind, p_name: name });
            if (error || !data?.id) throw new Error(error?.message ?? "Artifact creation failed");
            return { id: data.id, href: `/ai/library/${data.id}` };
            })();
          },
        }) } : {}),
        ...(settings.ai_data_scopes.includes("transactions") ? { transactions_previewCategory: tool({ description: "Read-only impact preview for exact selected transaction UUIDs and an existing category UUID. Returns a link where the user reviews current entries and explicitly confirms an audited bulk change. Never changes any transaction.", inputSchema: categoryPreviewSchema, execute: ({ transactionIds, categoryId }) => aiEvidence(["transactions"], latest =>
          loadCategoryPreview(latest.supabase, workspace.id, transactionIds, categoryId)) }) } : {}),
        ...(canInvestigate ? { reviews_investigate: tool({ description: "Investigate the selected query or an explicitly dated default review, with exact spending changes, account evidence, classification limitations and permitted planning evidence. Read-only.", inputSchema: z.object({ query: investigationSchema.optional() }).strict(), execute: ({ query } = {}) => aiEvidence(["accounts", "transactions"], latest =>
          loadFinancialReviewEvidence(latest.supabase, latest.workspace, latest.settings, query), true, true) }) } : {}),
        ...(canInvestigate ? { reviews_start: tool({ description: "Investigate the current user's finance question through a bounded, durable, cancelable review. Preserve their chosen dates, entities and focus in query/focus; the application binds the exact question and visible navigation context. Use ordinary finance queries for quick answers, and this tool when follow-up evidence gathering or a saved report is useful. Do not start when the user declines investigation or only asks what a review does. Repeated calls reuse one job; no canonical financial changes or artifact generation.", inputSchema: reviewRequestSchema.omit({question: true, version: true, context: true, allowedScopes: true}), execute: (input = {includePlanning: false, output: "answer", budget: {maxQueries: 6, maxSupportRecords: 60, maxOutputTokens: 4000, maxDurationMs: 90000}}) => aiEvidence(["accounts", "transactions"], async latest => {
          if (request.signal.aborted) throw new Error("Request canceled");
          if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL) throw new Error("Financial review service is not configured");
          const specification = resolveReviewRequest({...input, version: 1, question: message, context: capturedContext, allowedScopes: settings.ai_data_scopes}, calendarDate(new Date(), settings.timezone));
          if (specification.includePlanning) requireAiScope(latest.settings, "planning");
          return { ...await startFinancialReview(latest.supabase, workspace.id, requestId, requestId, specification), href: "/ai" };
        }) }) } : {}),
        ...(settings.ai_data_scopes.includes("accounts") ? { accounts_list: tool({ description: "List the user's accounts", inputSchema: z.object({}), execute: () => aiEvidence(["accounts"], latest => listAccounts(latest)) }),
        accounts_getBalances: tool({ description: "Get dated balances, provenance and source coverage", inputSchema: z.object({}), execute: () => aiEvidence(["accounts"], latest => getBalances(latest, latest.settings.ai_data_scopes.includes("imports")), false, true) }) } : {}),
        ...(settings.ai_data_scopes.includes("transactions") ? { analytics_cashflow: tool({ description: "Exact accepted posted income/spending with source coverage. Choose view base for direct exact posting-date FX and per-canonical-posting half-away rounding, or original for separate currency subtotals. Omitted view preserves single-currency accounting. Conversion completeness does not prove statement completeness; partial totals are not bounds. Missing rates return incomplete evidence, never guessed money.", inputSchema: financeToolSchemas.periodInput, execute: input => aiEvidence(["transactions"], latest => cashflow(input, latest, latest.settings.ai_data_scopes.includes("imports")), false, true) }),
        transactions_search: tool({ description: "Find transactions, newest first. Filter by description text, posted date range (from/to), absolute amount range in minor units, and limit (default 20, max 50).", inputSchema: financeToolSchemas.searchInput, execute: input => aiEvidence(["transactions"], latest => searchTransactions(input, latest)) }) } : {}),
        ...(settings.ai_data_scopes.includes("planning") ? { goals_list: tool({ description: "List the user's goals", inputSchema: z.object({}), execute: () => aiEvidence(["planning"], latest => listGoals(latest)) }) } : {}),
        ...(settings.ai_data_scopes.includes("planning") && settings.ai_data_scopes.includes("accounts") && settings.ai_data_scopes.includes("transactions") ? { forecast_evaluate: tool({ description: "Deterministic account headroom and dated funding shortfalls with source coverage. Choose accountId for available to spend; aggregate cash requires explicit funding. Cases are assumptions, not probabilities", inputSchema: forecastInput, execute: input => aiEvidence(["accounts", "transactions", "planning"], latest => evaluateForecast(input, latest), false, true) }) } : {}),
        ...(canChangeCategory ? {
          transactions_setCategory: tool({
            description: "Change only the category of a specific transaction, only when the current user explicitly asked for this change. Search first if its ID is unknown. The correction is audited and can be undone from the returned transaction link.",
            inputSchema: z.object({ transactionId: z.uuid(), category: z.string().trim().min(1).max(100) }).strict(),
            execute: async ({ transactionId, category }) => {
              if (!categoryCommand || transactionId !== categoryCommand.transactionId || category !== categoryCommand.category)
                throw new Error("Action must match the exact transaction and category selected by the user");
              const { data, error } = await supabase.rpc("chat_set_category", {
                p_request_id: requestId, p_transaction_id: transactionId, p_category: category,
              });
              if (error) throw error;
              return data;
            },
          }),
        } : {}),
      }) },
    });
    // The answer is all text the model wrote, across steps, exactly as streamed to the user.
    let text = "", stepBreak = false;
    for await (const part of result.fullStream) {
      if (part.type === "text-delta" && part.text) {
        const delta = stepBreak && text.trim() ? `\n\n${part.text}` : part.text;
        stepBreak = false; text += delta;
        emit({ type: "delta", text: delta });
      } else if (part.type === "finish-step") stepBreak = true;
      else if (part.type === "error") throw part.error instanceof Error ? part.error : new Error("AI request failed");
    }
    const [usage, steps] = await Promise.all([result.usage, result.steps]);
    const answer = text.trim();
    if (!answer) throw new Error("The model returned no answer");
    const current = await requireWorkspace();
    if (current.workspace.id !== workspace.id) throw new Error("Workspace changed");
    if (request.signal.aborted) throw new Error("Request canceled");
    requireAiScope(current.settings, ...readScopes);
    const toolsUsed = [...new Set(steps.flatMap(step => step.toolResults.flatMap(toolResult => toolResult ? [toolResult.toolName] : [])))];
    const followUps = chatFollowUps(message, toolsUsed, modelFollowUps);
    // The answer is final; show it while the durable publication below completes.
    emit({ type: "answer", conversationId, answer, toolsUsed, followUps });
    const finished = await supabase.rpc("finish_chat_request", { p_request_id: requestId, p_status: "completed", p_content: answer,
      p_usage: reportedUsage(model.modelId, usage), p_tool_calls: toolCalls });
    if (finished.error) throw finished.error;
    if (finished.data !== "completed") return [{ status: finished.data, error: `Request is ${finished.data}` }, 409];
    return [{ conversationId, answer, toolsUsed, followUps }, 200];
  } catch (error) {
    const failure = error instanceof Error ? error.message : "AI request failed";
    if (request.signal.aborted) await supabase.rpc("cancel_chat_request", { p_request_id: requestId });
    else await supabase.rpc("finish_chat_request", { p_request_id: requestId, p_status: "failed", p_content: failure.slice(0, 500) });
    return [{ error: error instanceof Error ? error.message : "AI request failed" }, 502];
  }
  }
  if (!streaming) { const [body, status] = await complete(() => {}); return Response.json(body, { status }); }
  // Opt-in NDJSON: tool progress and the verified answer arrive before publication finishes.
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({ start(controller) {
    const write = (event: ChatStreamEvent) => { try { controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)); } catch { /* the reader went away; work continues */ } };
    write({ type: "started" });
    void complete(write).then(([body, status]) => { write({ type: "result", status, body }); try { controller.close(); } catch { /* already closed */ } });
  } }), { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}


export async function PATCH(request: Request) {
  let context: Awaited<ReturnType<typeof requireWorkspace>>;
  try { context = await requireWorkspace(); } catch { return Response.json({ error: "Unauthorized" }, { status: 401 }); }
  const parsed = z.object({ requestId: z.uuid() }).strict().safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid cancellation" }, { status: 400 });
  const result = await context.supabase.rpc("cancel_chat_request", { p_request_id: parsed.data.requestId });
  if (result.error) return Response.json({ error: result.error.message }, { status: result.error.code === "P0002" ? 404 : 400 });
  return Response.json({ status: result.data });
}

