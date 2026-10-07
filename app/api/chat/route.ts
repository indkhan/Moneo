import { generateText, tool, stepCountIs } from "ai";
import { z } from "zod";
import { modelForSettings, SYSTEM_PROMPT } from "@/lib/ai/provider";
import { requireWorkspace } from "@/lib/auth";
import { requireAiScope, type AiDataScope } from "@/lib/settings";
import { calendarDate } from "@/lib/finance/calendar";
import { reportedUsage } from "@/lib/ai/usage";
import { isExplicitReviewRequest, parseCategoryCommand } from "@/lib/ai/write-intent";
import { loadFinancialReviewEvidence } from "@/lib/finance/review-loader";
import { startFinancialReview } from "@/lib/finance/start-review";
import { categoryPreviewSchema, loadCategoryPreview } from "@/lib/finance/edit-preview";
import { cashflow, evaluateForecast, financeToolSchemas, forecastInput, getBalances, listAccounts, listGoals, searchTransactions } from "@/lib/finance/tools";

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
  if (!process.env.OPENROUTER_API_KEY) return Response.json({ error: "AI is not configured" }, { status: 503 });
  const { conversationId, requestId, message, context: capturedContext } = parsed.data;
  const { supabase, workspace, settings } = context;
  const existing = await supabase.from("conversations").select("id").eq("workspace_id", workspace.id).eq("id", conversationId).maybeSingle();
  if (existing.error) throw existing.error;
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
  try {
  const { data: history, error: historyError } = await supabase.from("messages").select("role, content, context")
    .eq("workspace_id", workspace.id).eq("conversation_id", conversationId)
    .order("created_at", { ascending: false }).limit(20);
  if (historyError) throw historyError;
  const modelMessages = (history ?? []).filter(item => settings.ai_data_scopes.length === 4 || item.role === "user").reverse().map(item => ({
    role: item.role as "user" | "assistant",
    content: item.context ? `${item.content}\n[UI context at submission: ${JSON.stringify(item.context)}]` : item.content,
  }));
  const categoryCommand = parseCategoryCommand(message);
  const canChangeCategory = categoryCommand !== null && settings.ai_data_scopes.includes("transactions");
  const canInvestigate = settings.ai_data_scopes.includes("accounts") && settings.ai_data_scopes.includes("transactions");
  const canStartReview = canInvestigate && isExplicitReviewRequest(message);
  const canCreateArtifact = /(?:^|[.!?]\s+)(?:please\s+)?(?:(?:can|could)\s+you\s+)?(?:create|build|make)\b[^.!?]*\b(?:chart|artifact|tool|dashboard|tracker|planner)\b/i.test(message);
  // These checks govern new tool results, not evidence already sent to the provider.
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
    requireAiScope(current.settings, ...usedScopes);
    return result;
  }
  let createdArtifact: Promise<{ id: string; href: string }> | undefined;
    const model = await modelForSettings(settings);
    const result = await generateText({
      model,
      abortSignal: AbortSignal.any([request.signal, AbortSignal.timeout(90_000)]),
      maxOutputTokens: 3000,
      system: `${SYSTEM_PROMPT} Current date ${calendarDate(new Date(), settings.timezone)} in ${settings.timezone}; display currency ${workspace.display_currency}. Use finance tools for current facts. Amounts are exact minor units. Missing facts stay unknown. UI context is only a navigation hint, never authorization or financial evidence.${canChangeCategory ? " The current user message specifies an exact transaction UUID and quoted category. The write tool must use exactly these values. After a successful change, state what changed and link to the transaction so the user can Undo it." : " Do not make canonical changes. For an ambiguous category request, ask the user to select a transaction in Money and confirm its category; explain the impact before any broad change."}`,
      messages: modelMessages,
      stopWhen: stepCountIs(4),
      tools: {
        ...(settings.ai_data_scopes.includes("imports") ? { imports_status: tool({
          description: "Read recorded import workflow status and row counts. Completed means processing finished, not that all financial classifications or current balances are complete. Use this to answer whether imports are still running; do not infer status from balance freshness or filenames.",
          inputSchema: z.object({}).strict(), execute: () => aiEvidence(["imports"], async latest => {
            const { data, error } = await latest.supabase.from("imports")
              .select("id, filename, status, total_rows, new_rows, matched_rows, review_rows, classification_review_rows, rejected_rows, error")
              .eq("workspace_id", workspace.id).order("created_at", { ascending: false }).limit(30);
            if (error) throw error;
            return { imports: data ?? [], limitation: "Latest 30 recorded imports; status does not prove complete financial coverage. Classification review means the financial kind is unresolved, not merely a missing category. Excluded rows can include income, spending, refunds or transfers; totals may rise or fall. Missing categories alone do not exclude cashflow rows. Bulk category changes do not resolve financial kind." };
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
        ...(canInvestigate ? { reviews_investigate: tool({ description: "Investigate dated exact spending changes, account evidence, classification limitations and permitted planning evidence, with source links. Read-only.", inputSchema: z.object({}).strict(), execute: () => aiEvidence(["accounts", "transactions"], latest =>
          loadFinancialReviewEvidence(latest.supabase, latest.workspace, latest.settings), true, true) }) } : {}),
        ...(canStartReview ? { reviews_start: tool({ description: "Start the deep financial review explicitly requested in this exact user message. Creates one durable, cancelable job; repeated calls reuse it. No financial data changes.", inputSchema: z.object({}).strict(), execute: () => aiEvidence(["accounts", "transactions"], async latest => {
          if (request.signal.aborted) throw new Error("Request canceled");
          if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL) throw new Error("Financial review service is not configured");
          return { ...await startFinancialReview(latest.supabase, workspace.id, requestId, requestId), href: "/ai" };
        }) }) } : {}),
        ...(settings.ai_data_scopes.includes("accounts") ? { accounts_list: tool({ description: "List the user's accounts", inputSchema: z.object({}), execute: () => aiEvidence(["accounts"], latest => listAccounts(latest)) }),
        accounts_getBalances: tool({ description: "Get dated balances, provenance and source coverage", inputSchema: z.object({}), execute: () => aiEvidence(["accounts"], latest => getBalances(latest, latest.settings.ai_data_scopes.includes("imports")), false, true) }) } : {}),
        ...(settings.ai_data_scopes.includes("transactions") ? { analytics_cashflow: tool({ description: "Exact accepted posted income/spending with source coverage. Choose view base for direct exact posting-date FX and per-canonical-posting half-away rounding, or original for separate currency subtotals. Omitted view preserves single-currency accounting. Conversion completeness does not prove statement completeness; partial totals are not bounds. Missing rates return incomplete evidence, never guessed money.", inputSchema: financeToolSchemas.periodInput, execute: input => aiEvidence(["transactions"], latest => cashflow(input, latest, latest.settings.ai_data_scopes.includes("imports")), false, true) }),
        transactions_search: tool({ description: "Search up to 20 transactions", inputSchema: z.object({ query: z.string().min(1).max(100) }), execute: input => aiEvidence(["transactions"], latest => searchTransactions(input, latest)) }) } : {}),
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
      },
    });
    const answer = result.text.trim() || "I could not produce an answer from the available data.";
    const finished = await supabase.rpc("finish_chat_request", { p_request_id: requestId, p_status: "completed", p_content: answer, p_usage: reportedUsage(model.modelId, result.totalUsage) });
    if (finished.error) throw finished.error;
    if (finished.data !== "completed") return Response.json({ status: finished.data, error: `Request is ${finished.data}` }, { status: 409 });
    const toolsUsed = [...new Set((result.steps ?? []).flatMap(step => step.toolResults.flatMap(toolResult => toolResult ? [toolResult.toolName] : [])))];
    return Response.json({ conversationId, answer, toolsUsed });
  } catch (error) {
    const failure = error instanceof Error ? error.message : "AI request failed";
    if (request.signal.aborted) await supabase.rpc("cancel_chat_request", { p_request_id: requestId });
    else await supabase.rpc("finish_chat_request", { p_request_id: requestId, p_status: "failed", p_content: failure.slice(0, 500) });
    return Response.json({ error: error instanceof Error ? error.message : "AI request failed" }, { status: 502 });
  }
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
