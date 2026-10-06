import { z } from "zod";
import { accountLiquidity, availableToSpend, forecastDaily, internalFundingEvents, serializeAccountLiquidity, summarizeCashflow } from "./calculations";
import { requireWorkspace } from "@/lib/auth";
import { evaluatePlan, evaluatePlanForWorkspace } from "./model";
import { loadBalanceEvidence, resolveBalances } from "./balances";

type FinanceContext = Awaited<ReturnType<typeof requireWorkspace>>;

const periodInput = z.object({ from: z.iso.date(), to: z.iso.date(), currencyCode: z.string().regex(/^[A-Z]{3}$/) });
const searchInput = z.object({ query: z.string().min(1).max(100) });
export const forecastInput = z.object({
  horizonDays: z.number().int().min(1).max(365).default(30), scenarioId: z.uuid().optional(),
  accountId: z.string().min(1).max(100).optional(),
  funding: z.array(z.object({ date: z.iso.date(), currencyCode: z.string().regex(/^[A-Z]{3}$/),
    fromAccountId: z.string().min(1).max(100), toAccountId: z.string().min(1).max(100),
    amountMinor: z.string().regex(/^[1-9]\d{0,18}$/).refine(value => BigInt(value) <= 9223372036854775807n),
  })).max(100).optional(),
});

export async function listAccounts(context?: FinanceContext) {
  const { supabase, workspace } = context ?? await requireWorkspace();
  const { data, error } = await supabase.from("accounts").select("id, name, type, currency_code")
    .eq("workspace_id", workspace.id).order("name");
  if (error) throw error;
  return data;
}

export async function getBalances(context?: FinanceContext) {
  const { supabase, workspace } = context ?? await requireWorkspace();
  const evidence = await loadBalanceEvidence(supabase, workspace.id);
  return resolveBalances(evidence.accounts, evidence.snapshots, evidence.ledger, evidence.asOf, workspace.timezone);
}

export async function cashflow(input: unknown, context?: FinanceContext) {
  const { from, to, currencyCode } = periodInput.parse(input);
  if (from > to) throw new Error("From date is after to date");
  const { supabase, workspace } = context ?? await requireWorkspace();
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await supabase.from("effective_transactions")
      .select("amount_minor::text, currency_code, status, kind, review_reasons")
      .eq("workspace_id", workspace.id).gte("posted_on", from).lte("posted_on", to)
      .order("id")
      .range(offset, offset + 999);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const total = summarizeCashflow(rows.map(row => ({
    amountMinor: BigInt(row.amount_minor), currencyCode: row.currency_code,
    status: row.status as "posted" | "pending", kind: row.kind as "ordinary" | "transfer" | "refund",
    reviewReasons: row.review_reasons,
  })), currencyCode);
  return total ? {
    from, to, currencyCode, incomeMinor: total.incomeMinor.toString(),
    spendingMinor: total.spendingMinor.toString(), netMinor: total.netMinor.toString(),
    evidence: { transactionCount: rows.length, excludedPendingAndTransfers: true,
      includedTransactionCount: rows.filter(row => row.status === "posted" && row.kind !== "transfer" && !row.review_reasons?.length).length,
      excludedReviewRows: total.excludedReviewRows ?? 0, partial: total.partial ?? false,
      ...(total.partial ? { limitation: "Excluded classifications are unknown; these partial totals are not upper or lower bounds." } : {}) },
  } : { unavailable: "Some transactions require currency conversion", from, to, currencyCode };
}

export async function searchTransactions(input: unknown, context?: FinanceContext) {
  const { query } = searchInput.parse(input);
  const { supabase, workspace } = context ?? await requireWorkspace();
  const { data, error } = await supabase.from("transactions")
    .select("id, posted_on, description, amount_minor::text, currency_code, status, kind")
    .eq("workspace_id", workspace.id).ilike("description", `%${query.replace(/[%_]/g, "\\$&")}%`)
    .order("posted_on", { ascending: false }).limit(20);
  if (error) throw error;
  return data;
}

export async function listGoals(context?: FinanceContext) {
  const { supabase, workspace } = context ?? await requireWorkspace();
  const { data, error } = await supabase.from("goals")
    .select("id, name, target_minor::text, currency_code, target_date, status")
    .eq("workspace_id", workspace.id).order("created_at", { ascending: false });
  if (error) throw error;
  return data;
}

export async function evaluateForecast(input: unknown, context?: FinanceContext) {
  const args = forecastInput.parse(input);
  const plan = context ? await evaluatePlanForWorkspace(context.supabase, context.workspace, args.horizonDays, args.scenarioId) : await evaluatePlan(args.horizonDays, args.scenarioId);
  const fundingEvents = (args.funding ?? []).flatMap(funding => {
    if (funding.currencyCode !== plan.input.currencyCode) throw new Error("Funding currency must match forecast currency; convert explicitly first");
    if (funding.date < plan.input.startDate || funding.date >= new Date(Date.parse(`${plan.input.startDate}T00:00:00Z`) + plan.input.horizonDays * 86400000).toISOString().slice(0, 10)) throw new Error("Funding date outside forecast horizon");
    return internalFundingEvents({ ...funding, amountMinor: BigInt(funding.amountMinor) });
  });
  const assumptions = { ...plan.input, scenarioEvents: [...(plan.input.scenarioEvents ?? []), ...fundingEvents] };
  const forecast = forecastDaily(assumptions), available = availableToSpend(assumptions);
  if (forecast.status === "unavailable" || available.status === "unavailable")
    return { status: "unavailable", missingInputs: [...new Set([
      ...(forecast.status === "unavailable" ? forecast.missingInputs : []),
      ...(available.status === "unavailable" ? available.missingInputs : []),
    ])] };
  const last = forecast.days.at(-1)!;
  const liquidity = accountLiquidity(assumptions);
  if (liquidity.status === "unavailable") return liquidity;
  const account = args.accountId ? liquidity.accounts.find(account => account.accountId === args.accountId) : undefined;
  if (args.accountId && !account) throw new Error("Unknown account");
  return { status: "available", currencyCode: assumptions.currencyCode, horizonDays: args.horizonDays,
    expectedMinor: last.expectedMinor.toString(), conservativeMinor: last.conservativeMinor.toString(),
    optimisticMinor: last.optimisticMinor.toString(), availableToSpendMinor: account?.amountMinor.toString() ?? null,
    accountId: account?.accountId ?? null, limitingDate: account?.limitingDate ?? null,
    aggregateAvailableMinor: available.amountMinor.toString(), aggregateLimitingDate: available.limitingDate,
    aggregateRequiresExplicitFunding: true, liquidity: serializeAccountLiquidity(liquidity), casesAreAssumptionsNotProbabilities: true };
}

export const financeToolSchemas = { periodInput, searchInput };
