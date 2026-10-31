import { allPages } from "@/lib/all-pages";
import { z } from "zod";
import { accountLiquidity, availableToSpend, forecastDaily, withInternalFunding, serializeAccountLiquidity, summarizeCashflow } from "./calculations";
import { requireWorkspace } from "@/lib/auth";
import { evaluatePlan, evaluatePlanForWorkspace } from "./model";
import { loadBalanceEvidence, resolveBalances } from "./balances";
import { buildSourceCoverage, loadSourceCoverageMetadata } from "./source-coverage";
import { expenditurePosting, reportExpenditure } from "./expenditure";
import { loadExpenditureRates } from "./expenditure-rates";
import {forecastInput} from "./forecast-schema";
import { loadWealthItems, wealthOverview } from "./wealth";
export {forecastInput} from "./forecast-schema";

type FinanceContext = Awaited<ReturnType<typeof requireWorkspace>>;

const periodInput = z.object({ from: z.iso.date(), to: z.iso.date(), currencyCode: z.string().regex(/^[A-Z]{3}$/), view: z.enum(["original", "base"]).optional(), accountIds: z.array(z.uuid()).max(100).optional() });
const minorAmount = z.string().regex(/^\d{1,18}$/);
const searchInput = z.object({
  query: z.string().trim().min(1).max(100).optional(),
  from: z.iso.date().optional(), to: z.iso.date().optional(),
  minAmountMinor: minorAmount.optional(), maxAmountMinor: minorAmount.optional(),
  limit: z.number().int().min(1).max(50).default(20),
}).strict();
export async function listAccounts(context?: FinanceContext) {
  const { supabase, workspace } = context ?? await requireWorkspace();
  const { data, error } = await supabase.from("accounts").select("id, name, type, currency_code, version")
    .eq("workspace_id", workspace.id).order("name");
  if (error) throw error;
  return data;
}

export async function getBalances(context?: FinanceContext, canReadImports = true, retainSupport = false) {
  const { supabase, workspace } = context ?? await requireWorkspace();
  const [evidence, sourceMetadata] = await Promise.all([loadBalanceEvidence(supabase, workspace.id), loadSourceCoverageMetadata(supabase, workspace.id, canReadImports)]);
  // Same basis as Overview, Accounts and Wealth, so chat quotes the balances the screens show.
  return resolveBalances(evidence.accounts, evidence.snapshots, evidence.ledger, evidence.asOf, workspace.timezone, sourceMetadata, { preferLatestRecorded: true }).map(account => retainSupport ? { ...account,
    calculationEvidence: { snapshots: evidence.snapshots.filter(snapshot => snapshot.account_id === account.id), ledger: evidence.ledger.filter(row => row.account_id === account.id) } } : account);
}

export async function cashflow(input: unknown, context?: FinanceContext, canReadImports = true) {
  const { from, to, currencyCode, view, accountIds } = periodInput.parse(input);
  if (from > to) throw new Error("From date is after to date");
  const { supabase, workspace } = context ?? await requireWorkspace();
  function loadRows() {
    return allPages<{ id: string; parent_transaction_id: string; account_id: string; posted_on: string; version: number; amount_minor: string; currency_code: string; status: string; kind: string; review_reasons: string[] }>((start, end, count) => {
      const query = supabase.from("effective_transactions")
        .select("id, parent_transaction_id, account_id, posted_on, version, amount_minor::text, currency_code, status, kind, review_reasons", count ? { count } : undefined)
        .eq("workspace_id", workspace.id).gte("posted_on", from).lte("posted_on", to);
      return (accountIds ? query.in("account_id", accountIds) : query).order("id").range(start, end);
    });
  }
  // Rows, source metadata and rates are independent reads, so they load together.
  const [rows, sourceMetadata, rates] = await Promise.all([loadRows(), loadSourceCoverageMetadata(supabase, workspace.id, canReadImports),
    view === "base" ? loadExpenditureRates(supabase, workspace.id, { from, to, currencyCode }) : []]);
  const sourceCoverage = buildSourceCoverage({ from, to, ...(view ? {} : { currencyCode }), ...(accountIds ? { accountIds } : {}) }, rows, sourceMetadata?.imports, sourceMetadata?.sources);
  if (view) {
    const reporting = reportExpenditure(rows.map(expenditurePosting), rates, { from, to, currencyCode, view, accountIds });
    return { from, to, currencyCode, sourceCoverage, reporting, calculationEvidence: { rows, rates }, conversionCoverage: reporting.conversionCoverage, resultBasis: reporting.resultBasis,
      ...(reporting.totals ?? { unavailable: reporting.limitation ?? "Reporting evidence unavailable" }),
      evidence: { transactionCount: rows.length, includedTransactionCount: reporting.includedTransactionCount, excludedPendingAndTransfers: true,
        excludedReviewRows: reporting.conversionCoverage.excludedClassificationCount, partial: reporting.status === "incomplete", limitation: reporting.limitation } };
  }
  const total = summarizeCashflow(rows.map(row => ({
    amountMinor: BigInt(row.amount_minor), currencyCode: row.currency_code,
    status: row.status as "posted" | "pending", kind: row.kind as "ordinary" | "transfer" | "refund",
    reviewReasons: row.review_reasons,
  })), currencyCode);
  return total ? {
    from, to, currencyCode, sourceCoverage, calculationEvidence: { rows }, incomeMinor: total.incomeMinor.toString(),
    spendingMinor: total.spendingMinor.toString(), netMinor: total.netMinor.toString(),
    evidence: { transactionCount: rows.length, excludedPendingAndTransfers: true,
      includedTransactionCount: rows.filter(row => row.status === "posted" && row.kind !== "transfer" && !row.review_reasons?.length).length,
      excludedReviewRows: total.excludedReviewRows ?? 0, partial: total.partial ?? false,
      ...(total.partial ? { limitation: "Some rows await classification review and are excluded." } : {}) },
  } : { unavailable: "Some transactions require currency conversion", from, to, currencyCode, sourceCoverage, calculationEvidence: { rows } };
}

export async function searchTransactions(input: unknown, context?: FinanceContext) {
  const { query, from, to, minAmountMinor, maxAmountMinor, limit } = searchInput.parse(input);
  const { supabase, workspace } = context ?? await requireWorkspace();
  let request = supabase.from("transactions")
    .select("id, account_id, category_id, merchant_id, posted_on, description, amount_minor::text, currency_code, status, kind, review_reasons, version")
    .eq("workspace_id", workspace.id);
  if (query) request = request.ilike("description", `%${query.replace(/[%_]/g, "\\$&")}%`);
  if (from) request = request.gte("posted_on", from);
  if (to) request = request.lte("posted_on", to);
  // Amount bounds apply to the absolute amount, so spending (negative) and income match alike.
  if (minAmountMinor || maxAmountMinor) {
    const low = minAmountMinor ?? "0", high = maxAmountMinor ?? "999999999999999999";
    request = request.or(`and(amount_minor.gte.${low},amount_minor.lte.${high}),and(amount_minor.gte.-${high},amount_minor.lte.-${low})`);
  }
  const { data, error } = await request.order("posted_on", { ascending: false }).limit(limit);
  if (error) throw error;
  const parents = data ?? [];
  type EffectiveSearchRow = { id: string; parent_transaction_id: string; amount_minor: string; currency_code: string; status: string; kind: string; review_reasons: string[] };
  const effective: EffectiveSearchRow[] = [];
  if (parents.length) for (let offset = 0; ; offset += 500) {
    const page = await supabase.from("effective_transactions")
      .select("id, parent_transaction_id, account_id, posted_on, amount_minor::text, currency_code, status, kind, review_reasons, category_id, merchant_id, version")
      .eq("workspace_id", workspace.id).in("parent_transaction_id", parents.map(row => row.id)).order("id").range(offset, offset + 499);
    if (page.error) throw page.error;
    if (effective.length + (page.data?.length ?? 0) > 100_000) throw new Error("Search allocation evidence exceeds the current limit");
    effective.push(...(page.data ?? []) as EffectiveSearchRow[]);
    if (!page.data || page.data.length < 500) break;
  }
  return parents.map(row => {
    const components = effective.filter(component => component.parent_transaction_id === row.id);
    const unresolved = Boolean(row.review_reasons?.length || components.some(component => component.review_reasons?.length));
    return { ...row, review_reasons: row.review_reasons ?? [], classificationStatus: unresolved ? "unresolved" : "resolved",
      financialKind: unresolved ? null : row.kind, confirmedSpending: !unresolved && row.status === "posted" && row.kind === "ordinary" && BigInt(row.amount_minor) < 0n,
      amountBasis: "canonical_parent", effectiveRows: components,
      allocationSemantics: "Parent amount; effectiveRows are its split components (do not add both).",
      link: `/money/transactions?transaction=${row.id}` };
  });
}

export async function listWealth(context?: FinanceContext) {
  const { supabase, workspace } = context ?? await requireWorkspace();
  return wealthOverview(await loadWealthItems(supabase, workspace.id));
}

export async function listGoals(context?: FinanceContext) {
  const { supabase, workspace } = context ?? await requireWorkspace();
  const { data, error } = await supabase.from("goals")
    .select("id, name, target_minor::text, currency_code, target_date, status, version")
    .eq("workspace_id", workspace.id).order("created_at", { ascending: false });
  if (error) throw error;
  return data;
}

export async function evaluateForecast(input: unknown, context?: FinanceContext) {
  const args = forecastInput.parse(input);
  const plan = context ? await evaluatePlanForWorkspace(context.supabase, context.workspace, args.horizonDays, args.scenarioId, { canReadImports: context.settings.ai_data_scopes.includes("imports") }) : await evaluatePlan(args.horizonDays, args.scenarioId);
  const assumptions = withInternalFunding(plan.input, (args.funding ?? []).map(funding => ({ ...funding, amountMinor: BigInt(funding.amountMinor) })));
  const forecast = forecastDaily(assumptions), available = availableToSpend(assumptions);
  const calculationEvidence = JSON.parse(JSON.stringify({ source: plan.calculationEvidence, input: assumptions, forecast, available }, (_key, value) => typeof value === "bigint" ? value.toString() : value));
  if (forecast.status === "unavailable" || available.status === "unavailable")
    return { status: "unavailable", sourceCoverage: plan.sourceCoverage, sourceVersion: plan.sourceVersion, calculationEvidence, missingInputs: [...new Set([
      ...(forecast.status === "unavailable" ? forecast.missingInputs : []),
      ...(available.status === "unavailable" ? available.missingInputs : []),
    ])] };
  const last = forecast.days.at(-1)!;
  const liquidity = accountLiquidity(assumptions);
  if (liquidity.status === "unavailable") return { ...liquidity, sourceCoverage: plan.sourceCoverage, sourceVersion: plan.sourceVersion, calculationEvidence };
  const account = args.accountId ? liquidity.accounts.find(account => account.accountId === args.accountId) : undefined;
  if (args.accountId && !account) throw new Error("Unknown account");
  return { status: "available", sourceCoverage: plan.sourceCoverage, resultBasis: plan.resultBasis, currencyCode: assumptions.currencyCode, horizonDays: args.horizonDays,
    period: { from: assumptions.startDate, to: last.date },
    sourceVersion: plan.sourceVersion, calculationEvidence: { ...calculationEvidence, liquidity: serializeAccountLiquidity(liquidity) },
    expectedMinor: last.expectedMinor.toString(), conservativeMinor: last.conservativeMinor.toString(),
    optimisticMinor: last.optimisticMinor.toString(), availableToSpendMinor: account?.spendableMinor.toString() ?? null,
    accountId: account?.accountId ?? null, limitingDate: account?.spendingLimitingDate ?? null,
    aggregateAvailableMinor: available.amountMinor.toString(), aggregateLimitingDate: available.limitingDate,
    aggregateRequiresExplicitFunding: true, liquidity: serializeAccountLiquidity(liquidity), casesAreAssumptionsNotProbabilities: true };
}

export const financeToolSchemas = { periodInput, searchInput };
