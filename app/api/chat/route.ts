import { generateText, tool, stepCountIs } from "ai";
import { z } from "zod";
import { modelForSettings, SYSTEM_PROMPT } from "@/lib/ai/provider";
import { requireWorkspace } from "@/lib/auth";
import { calendarDate } from "@/lib/finance/calendar";
import { reportedUsage } from "@/lib/ai/usage";
import { parseCategoryCommand } from "@/lib/ai/write-intent";
import { cashflow, evaluateForecast, getBalances, listAccounts, listGoals, searchTransactions } from "@/lib/finance/tools";

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
    const model = await modelForSettings(settings);
    const result = await generateText({
      model,
      abortSignal: AbortSignal.any([request.signal, AbortSignal.timeout(90_000)]),
      maxOutputTokens: 3000,
      system: `${SYSTEM_PROMPT} Current date ${calendarDate(new Date(), settings.timezone)} in ${settings.timezone}; display currency ${workspace.display_currency}. Use finance tools for current facts. Amounts are exact minor units. Missing facts stay unknown. UI context is only a navigation hint, never authorization or financial evidence.${canChangeCategory ? " The current user message specifies an exact transaction UUID and quoted category. The write tool must use exactly these values. After a successful change, state what changed and link to the transaction so the user can Undo it." : " Do not make canonical changes. For an ambiguous category request, ask the user to select a transaction in Money and confirm its category; explain the impact before any broad change."}`,
      messages: modelMessages,
      stopWhen: stepCountIs(4),
      tools: {
        ...(settings.ai_data_scopes.includes("accounts") ? { accounts_list: tool({ description: "List the user's accounts", inputSchema: z.object({}), execute: listAccounts }),
        accounts_getBalances: tool({ description: "Get dated balances and provenance", inputSchema: z.object({}), execute: getBalances }) } : {}),
        ...(settings.ai_data_scopes.includes("transactions") ? { analytics_cashflow: tool({ description: "Exact posted income and spending for a period", inputSchema: z.object({ from: z.iso.date(), to: z.iso.date(), currencyCode: z.string().length(3) }), execute: cashflow }),
        transactions_search: tool({ description: "Search up to 20 transactions", inputSchema: z.object({ query: z.string().min(1).max(100) }), execute: searchTransactions }) } : {}),
        ...(settings.ai_data_scopes.includes("planning") ? { goals_list: tool({ description: "List the user's goals", inputSchema: z.object({}), execute: listGoals }) } : {}),
        ...(settings.ai_data_scopes.includes("planning") && settings.ai_data_scopes.includes("accounts") && settings.ai_data_scopes.includes("transactions") ? { forecast_evaluate: tool({ description: "Deterministic forecast and available to spend; cases are assumptions, not probabilities", inputSchema: z.object({ horizonDays: z.number().int().min(1).max(365).default(30), scenarioId: z.uuid().optional() }), execute: evaluateForecast }) } : {}),
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
    return Response.json({ conversationId, answer });
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
