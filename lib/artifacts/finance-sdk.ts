import { requireWorkspace } from "@/lib/auth";
import { withInternalFunding, summarizeCashflow, type CashflowTransaction } from "@/lib/finance/calculations";
import { defaultTripScenario, evaluateTripScenario, tripHorizon, tripScenarioSchema } from "@/lib/finance/trip-scenario";
import { evaluatePlan } from "@/lib/finance/model";
import { getBalances } from "@/lib/finance/tools";
import { calendarDate } from "@/lib/finance/calendar";
import { requireAiScope } from "@/lib/settings";
import { z } from "zod";
import { buildSourceCoverage, loadSourceCoverage } from "@/lib/finance/source-coverage";
import { expenditurePosting, reportExpenditure } from "@/lib/finance/expenditure";
import { loadExpenditureRates } from "@/lib/finance/expenditure-rates";
import { runInvestigation } from "@/lib/finance/investigation-reader";

export async function investigationForArtifact(artifactId: string, input: unknown, permission: "spending" | "cashflow" = "spending") {
  const context = await requirePermission(artifactId, permission);
  requireAiScope(context.settings, "accounts", "transactions");
  const result = await runInvestigation(input, context, { canReadImports: context.settings.ai_data_scopes.includes("imports") });
  // Do not silently drop groups/provenance to fit the generated-code memory budget.
  if (result.groups.length > 500 || (result.reporting?.postings.length ?? 0) > 500) throw new Error("Artifact investigation exceeds 500 groups or canonical postings; narrow its scope or open the complete Money investigation");
  const latest = await requirePermission(artifactId, permission);
  if (latest.workspace.id !== context.workspace.id) throw new Error("Workspace changed");
  requireAiScope(latest.settings, "accounts", "transactions", ...(context.settings.ai_data_scopes.includes("imports") ? ["imports" as const] : []));
  return result;
}

async function requirePermission(artifactId: string, permission: string) {
  const context = await requireWorkspace();
  const { supabase, workspace, settings } = context;
  if (permission === "spending" || permission === "cashflow") requireAiScope(settings, "transactions");
  else if (permission === "balances") requireAiScope(settings, "accounts");
  else if (permission === "forecast") requireAiScope(settings, "accounts", "transactions", "planning");
  else if (permission === "goals") requireAiScope(settings, "accounts", "planning");
  const { data, error } = await supabase.from("artifacts")
    .select("permissions, active_version_id").eq("id", artifactId).eq("workspace_id", workspace.id).single();
  if (error || !data?.active_version_id || !Array.isArray(data.permissions) || !data.permissions.includes(permission))
    throw new Error("Artifact permission denied");
  return context;
}

export async function balancesForArtifact(artifactId: string) {
  const context = await requirePermission(artifactId, "balances");
  const balances = await getBalances(context, context.settings?.ai_data_scopes.includes("imports") ?? false);
  if (context.settings?.ai_data_scopes.includes("imports")) {
    const current = await requireWorkspace();
    if (current.workspace.id !== context.workspace.id) throw new Error("Workspace changed");
    requireAiScope(current.settings, "accounts", "imports");
  }
  return { currency: context.workspace.display_currency, balances,
    sourceCoverage: buildSourceCoverage({ from: "0001-01-01", to: calendarDate(new Date(), context.workspace.timezone), ledgerBasis: "balance_activity" }, []) };
}

export async function spendingForArtifact(artifactId: string, query: string, permission: "spending" | "cashflow" = "spending", month?: string, reportingView?: "original" | "base") {
  const view = z.enum(["original", "base"]).optional().parse(reportingView);
  const { supabase, workspace, settings } = await requirePermission(artifactId, permission);
  const today = calendarDate(new Date(), workspace.timezone);
  const from = z.iso.date().parse(`${month ?? today.slice(0, 7)}-01`);
  if (from > today) throw new Error("Choose a current or past month");
  const nextMonth = new Date(`${from}T00:00:00Z`);
  nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
  const monthEnd = new Date(nextMonth.getTime() - 86400000).toISOString().slice(0, 10);
  const to = monthEnd < today ? monthEnd : today;
  const transactions: { id: string; parent_transaction_id?: string; version?: number; account_id: string; posted_on: string; description: string; amount_minor: string;
    currency_code: string; category_id: string | null; status: CashflowTransaction["status"];
    kind: CashflowTransaction["kind"]; review_reasons: string[] }[] = [];
  for (let offset = 0; ; offset += 1000) {
    let rows = supabase.from("effective_transactions")
      .select("id, parent_transaction_id, version, account_id, posted_on, description, amount_minor::text, currency_code, category_id, status, kind, review_reasons")
      .eq("workspace_id", workspace.id)
      .gte("posted_on", from).lte("posted_on", to)
      .order("posted_on", { ascending: false }).order("id");
    if (!view) rows = rows.eq("status", "posted").neq("kind", "transfer");
    if (query) rows = rows.ilike("description", `%${query.replace(/[%_]/g, "\\$&")}%`);
    const { data, error } = await rows.range(offset, offset + 999);
    if (error) throw error;
    transactions.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const rates = view === "base" ? await loadExpenditureRates(supabase, workspace.id, { from, to, currencyCode: workspace.display_currency }) : [];
  const report = (rows: typeof transactions) => reportExpenditure(rows.map(expenditurePosting), rates, { from, to, currencyCode: workspace.display_currency, view: view! });
  const reporting = view ? report(transactions) : undefined;
  const summarize = (rows: typeof transactions, canonical = view ? report(rows) : undefined) => {
  if (canonical) return { ...(canonical.totals ?? { unavailable: canonical.limitation ?? "Reporting evidence unavailable" }),
    excludedReviewRows: canonical.conversionCoverage.excludedClassificationCount, partial: canonical.status === "incomplete",
    conversionCoverage: canonical.conversionCoverage, resultBasis: canonical.resultBasis };
  const total = summarizeCashflow(rows.map(row => ({
    amountMinor: BigInt(row.amount_minor), currencyCode: row.currency_code,
    status: row.status as CashflowTransaction["status"], kind: row.kind as CashflowTransaction["kind"],
    reviewReasons: row.review_reasons,
  })), workspace.display_currency);
  return total ? { incomeMinor: total.incomeMinor.toString(), spendingMinor: total.spendingMinor.toString(), netMinor: total.netMinor.toString(),
    excludedReviewRows: total.excludedReviewRows ?? 0, partial: total.partial ?? false }
    : { unavailable: "Some transactions require currency conversion" };
  };
  const accounts = new Map<string, typeof transactions>();
  for (const row of transactions) {
    if (!row.account_id) continue;
    const group = accounts.get(row.account_id) ?? [];
    group.push(row); accounts.set(row.account_id, group);
  }
  const summary = summarize(transactions, reporting);
  const byAccount = [...accounts].map(([id, rows]) => ({ id, ...summarize(rows) }));
  const canReadImports = settings?.ai_data_scopes.includes("imports") ?? false;
  const coverage = await loadSourceCoverage(supabase, workspace.id, { from, to, ...(view ? {} : { currencyCode: workspace.display_currency }) }, transactions, canReadImports);
  if (canReadImports) {
    const current = await requireWorkspace();
    if (current.workspace.id !== workspace.id) throw new Error("Workspace changed");
    requireAiScope(current.settings, "transactions", "imports");
  }
  const sourceCoverage = { ...coverage, lifecycleExclusionsKnown: !!view, scope: { ...coverage.scope,
    descriptionFilter: query ? "applied; source relevance unknown" : "none",
    effectiveRowFilter: view ? "all lifecycle rows in period; exclusions disclosed by canonical reporting" : "posted non-transfer rows; other lifecycle exclusions were not queried" } };
  return { summary, byAccount, reporting, conversionCoverage: reporting?.conversionCoverage, resultBasis: reporting?.resultBasis, sourceCoverage, transactions: transactions.filter(row => row.status === "posted" && row.kind !== "transfer" && !row.review_reasons?.length), currency: workspace.display_currency, from, to, timezone: workspace.timezone ?? "Europe/Berlin" };
}

export async function tripForArtifact(artifactId: string, costMinor: bigint, accountId?: string, funding: Parameters<typeof withInternalFunding>[1] = [], rawScenario?: unknown) {
  if (typeof costMinor !== "bigint" || costMinor < 0n || (rawScenario === undefined && costMinor > 999999999999999999n)) throw new Error("Invalid trip cost");
  const { workspace, settings } = await requirePermission(artifactId, "forecast");
  const today = calendarDate(new Date(), workspace.timezone);
  const requested = rawScenario === undefined ? defaultTripScenario(today, workspace.display_currency, accountId ?? "unselected", costMinor) : tripScenarioSchema.parse(rawScenario);
  const horizon = tripHorizon(today, requested);
  const baseline = await evaluatePlan(horizon.days, undefined, settings?.ai_data_scopes.includes("imports") ?? false);
  const current = await requirePermission(artifactId, "forecast");
  if (current.workspace.id !== workspace.id) throw new Error("Workspace changed");
  if (settings?.ai_data_scopes.includes("imports")) requireAiScope(current.settings, "imports");
  const selectedId = accountId ?? baseline.preferences?.spending_account_id ?? (baseline.input.accounts.length === 1 ? baseline.input.accounts[0].id : undefined);
  if (accountId && !baseline.input.accounts.some(item => item.id === accountId)) throw new Error("Unknown account");
  const scenario = rawScenario === undefined ? { ...requested, payments: requested.payments.map(item => ({ ...item, accountId: selectedId ?? "unselected" })) } : requested;
  const result = evaluateTripScenario(withInternalFunding(baseline.input, funding), scenario);
  const selected = result.liquidity.status === "available" ? result.liquidity.accounts.find(item => item.accountId === result.accountId) : null;
  const withTrip = result.tripLiquidity.status === "available" ? result.tripLiquidity.accounts.find(item => item.accountId === result.accountId) : null;
  return { ...result, tripResult: result,
    baseline: selected ? { status: "available" as const, ...selected, amountMinor: BigInt(selected.spendableMinor), limitingDate: selected.spendingLimitingDate } : { status: "unavailable" as const },
    withTrip: withTrip ? { status: "available" as const, ...withTrip, amountMinor: BigInt(withTrip.spendableMinor), limitingDate: withTrip.spendingLimitingDate } : null,
    tripDate: scenario.startsOn, sourceCoverage: baseline.sourceCoverage, resultBasis: baseline.resultBasis,
    accounts: baseline.input.accounts.map(item => ({ id: item.id, currencyCode: item.currencyCode, name: baseline.accountLabels?.find(account => account.id === item.id)?.name ?? item.id })),
    unavailable: !selectedId && rawScenario === undefined ? "Choose a paying account; aggregate cash requires explicit funding" : result.unavailable };
}

export async function goalsForArtifact(artifactId: string) {
  const context = await requirePermission(artifactId, "goals");
  const { supabase, workspace } = context;
  const [{ data: goals, error: goalsError }, { data: allocations, error: allocationsError }, balances] = await Promise.all([
    supabase.from("goals").select("id, name, target_minor::text, currency_code, target_date, status, recorded_saved_minor::text, saved_as_of, planned_monthly_minor::text, contribution_starts_on")
      .eq("workspace_id", workspace.id).order("created_at", { ascending: false }),
    supabase.from("goal_allocations").select("goal_id, account_id, amount_minor::text")
      .eq("workspace_id", workspace.id),
    getBalances(context, false),
  ]);
  if (goalsError || allocationsError) throw goalsError ?? allocationsError;
  const today = calendarDate(new Date(), workspace.timezone);
  const from = (goals ?? []).flatMap(goal => goal.saved_as_of && goal.saved_as_of <= today ? [goal.saved_as_of] : []).sort()[0] ?? today;
  return { goals: goals ?? [], allocations: allocations ?? [], balances, currency: workspace.display_currency, timezone: workspace.timezone,
    sourceCoverage: buildSourceCoverage({ from, to: today, recordBasis: "manual_goals" }, []),
    resultBasis: "dated recorded savings and virtual reservations; source completeness not evaluated" };
}

